// Lefty's eyes: reads the clickable parts of the app the user is working in, using Windows UI Automation.
// Runs as a long-lived child of the Electron app. One JSON request per stdin line, one JSON reply per stdout line.
//
//   {"id":1,"cmd":"snapshot"}              -> elements of the last app the user was in (never Lefty itself)
//   {"id":2,"cmd":"snapshot","hwnd":1234}  -> elements of a specific window (used by tests)
//   {"id":3,"cmd":"focus"}                 -> give keyboard focus back to the user's app
//
// A snapshot covers the app window plus its open menus, dropdowns and dialogs (separate windows in most apps).
// Rectangles are physical screen pixels; Electron converts them to its own units (DIPs).
//
// Uses native UI Automation (COM), not the older .NET System.Windows.Automation wrapper: the wrapper reports
// some elements of apps without display-scaling support in the app's "pretend 100%" units, so on a 125% screen
// Lefty pointed ~40px off. Native UIA converts every rectangle to real pixels. The COM interface definitions are
// generated from Windows' own type library by tlbgen.cs at build time.
// Built with the C# 5 compiler that ships with Windows (.NET Framework 4), so no install is needed.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Interop.UIAutomationClient;

static class UiaHelper
{
    const int MaxElements = 400;
    const int SnapshotBudgetMs = 4000;

    // UI Automation property ids (UIAutomationClient.h)
    const int NameProperty = 30005;
    const int ControlTypeProperty = 30003;
    const int BoundingRectangleProperty = 30001;
    const int AutomationIdProperty = 30011;
    const int IsEnabledProperty = 30010;
    const int IsOffscreenProperty = 30022;
    const int IsControlElementProperty = 30016;
    const int MenuItemType = 50011;
    const int ListItemType = 50007;

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

    static int leftyPid;                   // Electron main process: owns Lefty's windows
    static IntPtr lastUserWindow = IntPtr.Zero;
    static readonly object windowLock = new object();
    static readonly object writeLock = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static readonly CUIAutomation8 uia = new CUIAutomation8();

    // Control type id -> name, for the kinds of things a user clicks or types into.
    static readonly Dictionary<int, string> interactiveTypes = new Dictionary<int, string>
    {
        { 50000, "Button" }, { 50031, "SplitButton" }, { 50011, "MenuItem" }, { 50019, "TabItem" },
        { 50007, "ListItem" }, { 50024, "TreeItem" }, { 50005, "Hyperlink" }, { 50002, "CheckBox" },
        { 50013, "RadioButton" }, { 50003, "ComboBox" }, { 50004, "Edit" }, { 50015, "Slider" },
        { 50029, "DataItem" }, { 50035, "HeaderItem" }, { 50016, "Spinner" }, { 50030, "Document" },
        { 50023, "Tree" }, // e.g. a file dialog's folder pane, which Lefty rings for "pick any folder"
    };

    // Windows' own passing screens: they become "foreground" for a moment while the user switches apps
    // (Alt+Tab, clicking the taskbar, the Start menu, the Ctrl/Win+Space language switcher), but they
    // are never the app the user wants help with.
    static readonly HashSet<string> shellClasses = new HashSet<string>
    {
        "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "XamlExplorerHostIslandWindow", "MultitaskingViewFrame",
        "TaskSwitcherWnd", "TaskSwitcherOverlayWnd", "ForegroundStaging", "NotifyIconOverflowWindow",
        "TopLevelWindowForOverflowXamlIsland", "Windows.UI.Core.CoreWindow", "Shell_InputSwitchTopLevelWindow",
        "LockScreenBackstopFrame",
    };

    const uint WS_POPUP = 0x80000000;
    const int GWL_STYLE = -16;
    const uint GW_OWNER = 4;
    const int MaxWindows = 8;

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP = 2;
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    static void Main(string[] args)
    {
        // Physical pixels everywhere, so rectangles line up on scaled (125%, 150%) and mixed-DPI screens.
        SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
        if (args.Length > 0) int.TryParse(args[0], out leftyPid);
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);

        // Remember the last window the user was in. When Ctrl+Space is pressed Lefty's overlay takes focus,
        // so "the current foreground window" would be Lefty himself.
        var tracker = new Thread(TrackForeground) { IsBackground = true };
        tracker.Start();

        Write(new Dictionary<string, object> { { "ready", true } });

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            object id = null;
            try
            {
                var request = json.Deserialize<Dictionary<string, object>>(line);
                request.TryGetValue("id", out id);
                object cmd;
                request.TryGetValue("cmd", out cmd);
                object hwnd;
                IntPtr target = request.TryGetValue("hwnd", out hwnd) && hwnd != null
                    ? new IntPtr(Convert.ToInt64(hwnd))
                    : UserWindow();
                if ((cmd as string) == "snapshot")
                {
                    var reply = Snapshot(target);
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "focus")
                {
                    var reply = Focus(target);
                    reply["id"] = id;
                    Write(reply);
                }
                else
                {
                    Write(Error(id, "unknown command"));
                }
            }
            catch (Exception ex)
            {
                Write(Error(id, ex.Message));
            }
        }
    }

    static void TrackForeground()
    {
        while (true)
        {
            IntPtr hwnd = GetForegroundWindow();
            if (IsUserWindow(hwnd)) lock (windowLock) lastUserWindow = hwnd;
            Thread.Sleep(100);
        }
    }

    static bool IsUserWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) return false;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0 || pid == (uint)leftyPid || pid == (uint)Process.GetCurrentProcess().Id) return false;
        return !shellClasses.Contains(ClassOf(hwnd));
    }

    static string ClassOf(IntPtr hwnd)
    {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }

    static bool IsOwnedBy(IntPtr hwnd, IntPtr root)
    {
        for (IntPtr owner = GetWindow(hwnd, GW_OWNER); owner != IntPtr.Zero; owner = GetWindow(owner, GW_OWNER))
        {
            if (owner == root) return true;
        }
        return false;
    }

    // The app window plus whatever it has open on top: menus, dropdowns, dialogs and flyouts are separate
    // windows in most apps, so reading only the main window would miss the very things a step opens.
    // Returned in z-order, top first, so what the user actually sees wins ties.
    static List<IntPtr> AppWindows(IntPtr root)
    {
        uint rootPid;
        GetWindowThreadProcessId(root, out rootPid);
        var windows = new List<IntPtr>();
        bool sawRoot = false;
        EnumWindows((hwnd, _) =>
        {
            if (hwnd == root) { windows.Add(hwnd); sawRoot = true; return windows.Count < MaxWindows; }
            if (sawRoot || !IsWindowVisible(hwnd)) return true; // windows below the app can't be on top of it
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid != rootPid) return true;
            bool popup = ((uint)GetWindowLong(hwnd, GWL_STYLE) & WS_POPUP) != 0;
            if (popup || IsOwnedBy(hwnd, root)) windows.Add(hwnd);
            return windows.Count < MaxWindows;
        }, IntPtr.Zero);
        if (!sawRoot) windows.Add(root);
        return windows;
    }

    static IntPtr UserWindow()
    {
        IntPtr now = GetForegroundWindow();
        if (IsUserWindow(now)) return now;
        lock (windowLock) return lastUserWindow;
    }

    // Gives the keyboard back to the user's app once Lefty starts pointing. Lefty's overlay takes focus so the
    // user can type a goal, but many apps treat the first click on an inactive window as "activate" only,
    // so the click on Lefty's target would do nothing. Windows only lets the foreground process change the
    // foreground window, so the helper briefly shares input state with it (AttachThreadInput) to be allowed.
    static Dictionary<string, object> Focus(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Error(null, "no app window found");
        MSG message;
        PeekMessage(out message, IntPtr.Zero, 0, 0, 0); // AttachThreadInput fails unless this thread has a message queue; this creates it
        uint ignored;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
        uint thisThread = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != thisThread && AttachThreadInput(thisThread, foregroundThread, true);
        try
        {
            SetForegroundWindow(hwnd);
        }
        finally
        {
            if (attached) AttachThreadInput(thisThread, foregroundThread, false);
        }
        Thread.Sleep(50); // the switch is not instant
        string method = "attach";
        if (GetForegroundWindow() != hwnd)
        {
            // Fallback: Windows lets the process that sent the last input change the foreground window.
            // A bare Alt tap is that input; it goes to Lefty's own overlay, where it does nothing.
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            SetForegroundWindow(hwnd);
            Thread.Sleep(50);
            method = "alt";
        }
        return new Dictionary<string, object> { { "ok", true }, { "focused", GetForegroundWindow() == hwnd }, { "attached", attached }, { "method", method } };
    }

    static Dictionary<string, object> Snapshot(IntPtr hwnd)
    {
        var timer = Stopwatch.StartNew();
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Error(null, "no app window found");

        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        string processName = "";
        try { processName = Process.GetProcessById((int)pid).ProcessName; } catch { }
        var title = new StringBuilder(512);
        GetWindowText(hwnd, title, title.Capacity);

        tagRECT rootRect = uia.ElementFromHandle(hwnd).CurrentBoundingRectangle;

        // Fetch all needed properties in one cross-process call instead of one call per property.
        var cache = uia.CreateCacheRequest();
        cache.AddProperty(NameProperty);
        cache.AddProperty(ControlTypeProperty);
        cache.AddProperty(BoundingRectangleProperty);
        cache.AddProperty(AutomationIdProperty);
        cache.AddProperty(IsEnabledProperty);
        cache.AutomationElementMode = AutomationElementMode.AutomationElementMode_None;

        var condition = uia.CreateAndCondition(
            uia.CreatePropertyCondition(IsControlElementProperty, true),
            uia.CreatePropertyCondition(IsOffscreenProperty, false));

        var windows = AppWindows(hwnd);

        // Open menus and dropdowns: the screen areas where popup items can be.
        var popupAreas = new List<RECT>();
        foreach (IntPtr window in windows)
        {
            RECT area;
            if (window != hwnd && GetWindowRect(window, out area)) popupAreas.Add(area);
        }

        // Pass 1: everything UI Automation says is visible.
        // Pass 2: older-style menus (WinForms, MSAA) flag every item after the first as "offscreen" even while the
        // menu is open, so "Save As..." would be invisible to Lefty. Menu and list items inside an open popup are
        // visible whatever the flag says, so geometry decides for those.
        var passes = new List<KeyValuePair<IUIAutomationCondition, bool>>
        {
            new KeyValuePair<IUIAutomationCondition, bool>(condition, false),
        };
        if (popupAreas.Count > 0)
        {
            passes.Add(new KeyValuePair<IUIAutomationCondition, bool>(uia.CreateAndCondition(
                uia.CreatePropertyCondition(IsOffscreenProperty, true),
                uia.CreateOrCondition(
                    uia.CreatePropertyCondition(ControlTypeProperty, MenuItemType),
                    uia.CreatePropertyCondition(ControlTypeProperty, ListItemType))), true));
        }

        var elements = new List<object>();
        var seen = new HashSet<string>(); // a popup can also show up inside the main window's tree
        bool truncated = false;
        int skipped = 0;
        string lastError = null;
        foreach (var pass in passes)
        {
            foreach (IntPtr window in windows)
            {
                IUIAutomationElementArray found;
                try
                {
                    found = uia.ElementFromHandle(window).FindAllBuildCache(TreeScope.TreeScope_Descendants, pass.Key, cache);
                }
                catch (Exception ex)
                {
                    skipped++; // e.g. a menu closed while it was being read
                    lastError = ex.Message;
                    continue;
                }
                if (found == null) continue;

                for (int i = 0; i < found.Length; i++)
                {
                    if (elements.Count >= MaxElements || timer.ElapsedMilliseconds > SnapshotBudgetMs) { truncated = true; break; }
                    IUIAutomationElement el = found.GetElement(i);
                    string typeName;
                    if (!interactiveTypes.TryGetValue(el.CachedControlType, out typeName)) continue;
                    tagRECT r = el.CachedBoundingRectangle;
                    if (r.right - r.left < 2 || r.bottom - r.top < 2) continue;
                    if (pass.Value && !InsideAny(popupAreas, r)) continue;
                    string name = Clip(el.CachedName, 120);
                    if (!seen.Add(string.Format("{0}|{1}|{2},{3},{4},{5}", typeName, name, r.left, r.top, r.right, r.bottom))) continue;

                    elements.Add(new Dictionary<string, object>
                    {
                        { "i", elements.Count },
                        { "name", name },
                        { "type", typeName },
                        { "id", Clip(el.CachedAutomationId, 80) },
                        { "enabled", el.CachedIsEnabled != 0 },
                        { "rect", RectToDict(r) },
                    });
                }
                if (truncated) break;
            }
            if (truncated) break;
        }

        return new Dictionary<string, object>
        {
            { "ok", true },
            { "window", new Dictionary<string, object>
                {
                    { "hwnd", hwnd.ToInt64() },
                    { "title", title.ToString() },
                    { "process", processName },
                    { "rect", RectToDict(rootRect) },
                }
            },
            { "elements", elements },
            { "windows", windows.Count },
            { "skipped", skipped },
            { "skipError", lastError },
            { "truncated", truncated },
            { "ms", timer.ElapsedMilliseconds },
        };
    }

    static bool InsideAny(List<RECT> areas, tagRECT r)
    {
        int cx = (r.left + r.right) / 2;
        int cy = (r.top + r.bottom) / 2;
        foreach (var a in areas)
        {
            if (cx >= a.Left && cx <= a.Right && cy >= a.Top && cy <= a.Bottom) return true;
        }
        return false;
    }

    static Dictionary<string, object> RectToDict(tagRECT r)
    {
        if (r.right <= r.left || r.bottom <= r.top) return null;
        return new Dictionary<string, object>
        {
            { "x", r.left }, { "y", r.top }, { "w", r.right - r.left }, { "h", r.bottom - r.top },
        };
    }

    static string Clip(string s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= max ? s : s.Substring(0, max);
    }

    static Dictionary<string, object> Error(object id, string message)
    {
        return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", message } };
    }

    static void Write(object reply)
    {
        string text = json.Serialize(reply);
        lock (writeLock)
        {
            Console.Out.WriteLine(text);
            Console.Out.Flush();
        }
    }
}
