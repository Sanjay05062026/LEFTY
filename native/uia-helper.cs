// Lefty's eyes: reads the clickable parts of the app the user is working in, using Windows UI Automation.
// Runs as a long-lived child of the Electron app. One JSON request per stdin line, one JSON reply per stdout line.
//
//   {"id":1,"cmd":"snapshot"}              -> elements of the last app the user was in (never Lefty itself)
//   {"id":2,"cmd":"snapshot","hwnd":1234}  -> elements of a specific window (used by tests)
//   {"id":3,"cmd":"focus"}                 -> give keyboard focus back to the user's app
//   {"id":4,"cmd":"screenmode","hwnd":1234} -> is this window fullscreen? (used by tests)
//   {"id":5,"cmd":"windows"}               -> the app windows open on the PC (title, process), top first
//   {"id":6,"cmd":"focus","hwnd":1234}     -> bring that window to the front (restoring it if minimized)
//   {"id":7,"cmd":"caret","hwnd":1234}     -> where the text cursor is in that window's code editor (asked many
//                                             times a second while Lefty shows ghost code, so it must stay cheap)
//   {"id":8,"cmd":"keys","hwnd":1234,"keys":["ctrl+g","text:12:1","enter","wait:100"]}
//                                          -> presses keys in that window (only when the user asked Lefty to act:
//                                             reading or fixing their code); refuses if it isn't in front
//   {"id":9,"cmd":"click","hwnd":1234,"x":500,"y":300,"button":"left","count":1,"expect":"Save"}
//                                          -> Do it mode: clicks that point in that app (or one of its menus and
//                                             dialogs), then puts the mouse back; refuses if another window is in the
//                                             way or the thing there isn't the one expected ("expect": its name)
//   {"id":10,"cmd":"type","hwnd":1234,"text":"hello"} -> Do it mode: types into the focused box; refuses password boxes
//   {"id":11,"cmd":"scroll","hwnd":1234,"x":500,"y":300,"notches":-3} -> Do it mode: turns the mouse wheel there
//   {"id":12,"cmd":"peek","x":500,"y":300} -> what's under that point: { name, type } (before clicking a guessed spot)
//   {"id":13,"cmd":"peek","x":500,"y":300,"clickable":true}
//                                          -> the control a person clicking there means (a menu item, not the text
//                                             inside it) plus the window there: { name, type, rect, process, title,
//                                             windowRect } ("What does this do?")
//   {"id":14,"cmd":"front"}                -> the window in front: { hwnd, root, title, process, lefty, shell }
//                                             (focus mode checks it every second or two)
//   {"id":15,"cmd":"close","hwnd":1234,"how":"close"|"minimize"}
//                                          -> focus mode: asks that window to close (as its X button does, so an app
//                                             can still ask to save) or minimizes it
//
// Unasked, it also writes {"event":"screenmode","fullscreen":true|false,...} whenever a fullscreen app
// (a game, a video) comes to the front or leaves it, so Lefty can let go of Ctrl+Space while it is there.
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
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    const int SW_RESTORE = 9;
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int DWMWA_CLOAKED = 14;
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    const uint MONITOR_DEFAULTTONEAREST = 2;
    const uint WS_CAPTION = 0x00C00000;
    const int QUNS_RUNNING_D3D_FULL_SCREEN = 3;
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
                    var reply = SnapshotWithRetry(target);
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "focus")
                {
                    var reply = Focus(target);
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "screenmode")
                {
                    var reply = hwnd != null ? ScreenMode(target, false) : ScreenMode(GetForegroundWindow(), true);
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "windows")
                {
                    var reply = new Dictionary<string, object> { { "ok", true }, { "windows", OpenWindows() }, { "id", id } };
                    Write(reply);
                }
                else if ((cmd as string) == "front")
                {
                    var reply = Front();
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "close")
                {
                    object how;
                    request.TryGetValue("how", out how);
                    var reply = CloseWindow(target, (how as string) == "minimize");
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "caret")
                {
                    var reply = Caret(target);
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "keys")
                {
                    object keys, anyAppWindow;
                    request.TryGetValue("keys", out keys);
                    request.TryGetValue("anyAppWindow", out anyAppWindow);
                    var reply = PressKeys(target, keys as System.Collections.ArrayList, anyAppWindow is bool && (bool)anyAppWindow);
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "click" || (cmd as string) == "scroll")
                {
                    object x, y, button, count, expect, notches;
                    request.TryGetValue("x", out x);
                    request.TryGetValue("y", out y);
                    request.TryGetValue("button", out button);
                    request.TryGetValue("count", out count);
                    request.TryGetValue("expect", out expect);
                    request.TryGetValue("notches", out notches);
                    var reply = (cmd as string) == "click"
                        ? Click(target, Convert.ToInt32(x), Convert.ToInt32(y), button as string ?? "left", count == null ? 1 : Convert.ToInt32(count), expect as string)
                        : Scroll(target, Convert.ToInt32(x), Convert.ToInt32(y), notches == null ? -3 : Convert.ToInt32(notches));
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "peek")
                {
                    object x, y, clickable;
                    request.TryGetValue("x", out x);
                    request.TryGetValue("y", out y);
                    request.TryGetValue("clickable", out clickable);
                    var reply = Peek(Convert.ToInt32(x), Convert.ToInt32(y), clickable is bool && (bool)clickable);
                    reply["id"] = id;
                    Write(reply);
                }
                else if ((cmd as string) == "type")
                {
                    object text;
                    request.TryGetValue("text", out text);
                    var reply = TypeText(target, text as string ?? "");
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
        bool fullscreen = false;
        while (true)
        {
            IntPtr hwnd = GetForegroundWindow();
            if (IsUserWindow(hwnd)) lock (windowLock) lastUserWindow = hwnd;
            var mode = ScreenMode(hwnd, true);
            if ((bool)mode["fullscreen"] != fullscreen)
            {
                fullscreen = !fullscreen;
                mode.Remove("ok");
                mode["event"] = "screenmode";
                Write(mode);
            }
            Thread.Sleep(100);
        }
    }

    // A fullscreen app is one that covers its whole monitor with no title bar (games, videos, slideshows),
    // or a game in exclusive fullscreen. Maximized windows keep their title bar, so they never count.
    // Lefty's own overlay and the desktop also cover the screen; they are not "an app in front".
    // skipLefty is false only when a test asks about one of Lefty's own windows on purpose.
    static Dictionary<string, object> ScreenMode(IntPtr hwnd, bool skipLefty)
    {
        bool fullscreen = false, covers = false, titleBar = false;
        string process = "";
        if (hwnd != IntPtr.Zero && IsWindow(hwnd))
        {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            string cls = ClassOf(hwnd);
            bool ignored = (skipLefty && pid == (uint)leftyPid) || cls == "Progman" || cls == "WorkerW" || shellClasses.Contains(cls);
            if (!ignored)
            {
                RECT rect;
                var monitor = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
                covers = GetWindowRect(hwnd, out rect)
                    && GetMonitorInfo(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), ref monitor)
                    && rect.Left <= monitor.rcMonitor.Left && rect.Top <= monitor.rcMonitor.Top
                    && rect.Right >= monitor.rcMonitor.Right && rect.Bottom >= monitor.rcMonitor.Bottom;
                titleBar = ((uint)GetWindowLong(hwnd, GWL_STYLE) & WS_CAPTION) == WS_CAPTION;
                int state;
                bool exclusive = SHQueryUserNotificationState(out state) == 0 && state == QUNS_RUNNING_D3D_FULL_SCREEN;
                fullscreen = (covers && !titleBar) || exclusive;
                try { process = Process.GetProcessById((int)pid).ProcessName; } catch { }
            }
        }
        return new Dictionary<string, object> { { "ok", true }, { "fullscreen", fullscreen }, { "process", process }, { "coversScreen", covers }, { "titleBar", titleBar } };
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
    // The app windows a user would call "open": visible, titled, not owned by another window, not a tool window,
    // not hidden by Windows ("cloaked" Store apps on another desktop), not Lefty, not the shell. Top first.
    static List<object> OpenWindows()
    {
        var list = new List<object>();
        EnumWindows((hwnd, _) =>
        {
            if (!IsUserWindow(hwnd) || GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
            if ((GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
            int cloaked;
            if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            var title = new StringBuilder(512);
            GetWindowText(hwnd, title, title.Capacity);
            if (title.Length == 0) return true;
            string cls = ClassOf(hwnd);
            if (cls == "Progman" || cls == "WorkerW") return true;
            string process = ProcessNameOf(hwnd);
            list.Add(new Dictionary<string, object> { { "hwnd", hwnd.ToInt64() }, { "title", Clip(title.ToString(), 200) }, { "process", process }, { "minimized", IsIconic(hwnd) } });
            return list.Count < 40;
        }, IntPtr.Zero);
        return list;
    }

    static Dictionary<string, object> Focus(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Error(null, "no app window found");
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE); // a minimized window can't take focus
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
            // Fallback: Windows lets the process that sent the last input change the foreground window. A mouse move
            // of zero pixels is that input, and no app reacts to it. (A bare Alt tap, used before, could reach the app
            // just after it came forward: Notepad then showed its menu shortcuts and swallowed the next typed letters.)
            SendInput(1, new[] { new INPUT { type = 0, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = 0x1 } } } }, Marshal.SizeOf(typeof(INPUT)));
            SetForegroundWindow(hwnd);
            Thread.Sleep(50);
            method = "nudge";
        }
        return new Dictionary<string, object> { { "ok", true }, { "focused", GetForegroundWindow() == hwnd }, { "attached", attached }, { "method", method } };
    }

    // Ghost code: Lefty draws code at the text cursor for the user to type over, so he needs to know, many times a
    // second, which line the cursor is on and where that line is on screen. VS Code (outside screen-reader mode)
    // hides the text itself, but it still tells UI Automation the cursor line's rectangle (its left edge is where
    // column 1 starts), and its status bar says "Ln 12, Col 5". With the status bar item remembered, one read takes
    // about 2 ms. The editor's own area (without side bars and panels) keeps the ghost inside it.
    const int TextPatternId = 10014;
    const int ButtonType = 50000;
    const int TextType = 50020;
    const int StatusSearchEveryMs = 1000;
    static readonly System.Text.RegularExpressions.Regex lnCol = new System.Text.RegularExpressions.Regex(@"^Ln (\d+), Col (\d+)");
    static IUIAutomationElement statusItem;
    static IntPtr statusWindow = IntPtr.Zero;
    static IUIAutomationElement editorItem;    // the last focused element that knew the cursor (VS Code's text input)
    static IntPtr editorWindow = IntPtr.Zero;
    static long statusSearchedAt = -StatusSearchEveryMs;
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static readonly Dictionary<IntPtr, string> processOf = new Dictionary<IntPtr, string>();

    static Dictionary<string, object> Caret(IntPtr hwnd)
    {
        var reply = new Dictionary<string, object> { { "ok", true }, { "hwnd", hwnd.ToInt64() }, { "inFront", false } };
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || GetForegroundWindow() != hwnd) return reply;
        reply["inFront"] = true;
        string process;
        if (!processOf.TryGetValue(hwnd, out process))
        {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            try { process = Process.GetProcessById((int)pid).ProcessName; } catch { process = ""; }
            processOf[hwnd] = process;
        }
        reply["process"] = process;

        IUIAutomationElement focused = uia.GetFocusedElement();
        IUIAutomationElement source = focused;
        var text = focused == null ? null : focused.GetCurrentPattern(TextPatternId) as IUIAutomationTextPattern;
        IUIAutomationTreeWalker walker = uia.RawViewWalker;
        if (text != null)
        {
            editorItem = focused;
            editorWindow = hwnd;
        }
        else if (editorItem != null && editorWindow == hwnd && focused != null)
        {
            // While VS Code's suggestion list is open, the highlighted suggestion counts as focused, and it knows
            // nothing about the cursor; the editor still does. Its box is reported so ghost code can stay clear of it.
            try { text = editorItem.GetCurrentPattern(TextPatternId) as IUIAutomationTextPattern; source = editorItem; }
            catch (COMException) { editorItem = null; }
            IUIAutomationElement up = focused;
            for (int depth = 0; depth < 10 && up != null; depth++)
            {
                if ((up.CurrentClassName ?? "").Contains("editor-widget")) { reply["popup"] = RectToDict(up.CurrentBoundingRectangle); break; }
                up = walker.GetParentElement(up);
            }
        }
        if (text != null)
        {
            try
            {
                IUIAutomationTextRangeArray selection = text.GetSelection();
                var rects = selection != null && selection.Length > 0 ? selection.GetElement(0).GetBoundingRectangles() as double[] : null;
                if (rects != null && rects.Length >= 4)
                    reply["line"] = new Dictionary<string, object> { { "x", rects[0] }, { "y", rects[1] }, { "w", rects[2] }, { "h", rects[3] } };
            }
            catch (COMException) { if (source == editorItem) editorItem = null; } // the editor tab was closed
        }
        if (reply.ContainsKey("line"))
        {
            // The editor around the cursor: the nearest parent whose page class says "monaco-editor".
            IUIAutomationElement el = source;
            for (int depth = 0; depth < 12 && el != null; depth++)
            {
                el = walker.GetParentElement(el);
                if (el != null && (el.CurrentClassName ?? "").Contains("monaco-editor"))
                {
                    reply["area"] = RectToDict(el.CurrentBoundingRectangle);
                    break;
                }
            }
        }

        if (statusWindow != hwnd) { statusItem = null; statusWindow = hwnd; statusSearchedAt = -StatusSearchEveryMs; }
        string status = null;
        if (statusItem != null)
        {
            try { status = statusItem.CurrentName; } catch (COMException) { statusItem = null; }
        }
        if ((status == null || !lnCol.IsMatch(status)) && clock.ElapsedMilliseconds - statusSearchedAt >= StatusSearchEveryMs)
        {
            statusSearchedAt = clock.ElapsedMilliseconds;
            statusItem = FindStatusItem(hwnd);
            status = statusItem != null ? statusItem.CachedName : null;
        }
        var match = lnCol.Match(status ?? "");
        if (match.Success)
        {
            reply["ln"] = int.Parse(match.Groups[1].Value);
            reply["col"] = int.Parse(match.Groups[2].Value);
        }
        return reply;
    }

    // The "Ln 12, Col 5" item in the window's status bar (a button in VS Code, plain text in some editors).
    static IUIAutomationElement FindStatusItem(IntPtr hwnd)
    {
        var cache = uia.CreateCacheRequest();
        cache.AddProperty(NameProperty);
        cache.AddProperty(ControlTypeProperty);
        var condition = uia.CreateOrCondition(
            uia.CreatePropertyCondition(ControlTypeProperty, ButtonType),
            uia.CreatePropertyCondition(ControlTypeProperty, TextType));
        IUIAutomationElementArray found;
        try { found = uia.ElementFromHandle(hwnd).FindAllBuildCache(TreeScope.TreeScope_Descendants, condition, cache); }
        catch (COMException) { return null; }
        IUIAutomationElement text = null;
        for (int i = 0; found != null && i < found.Length; i++)
        {
            IUIAutomationElement el = found.GetElement(i);
            if (!lnCol.IsMatch(el.CachedName ?? "")) continue;
            if (el.CachedControlType == ButtonType) return el;
            if (text == null) text = el;
        }
        return text;
    }

    // Keys Lefty presses himself, only when the user asked him to act on their code ("Fix it for me", reading the file
    // to check it). "ctrl+shift+end" style combos, "text:..." types the characters as they are, "wait:120" pauses.
    // The window must be in front, so the keys can never land in another app.
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    const uint INPUT_KEYBOARD = 1;
    const uint KEY_EXTENDED = 0x1, KEY_UP = 0x2, KEY_UNICODE = 0x4;
    static readonly Dictionary<string, ushort> keyCodes = new Dictionary<string, ushort>
    {
        { "enter", 0x0D }, { "escape", 0x1B }, { "esc", 0x1B }, { "tab", 0x09 }, { "backspace", 0x08 }, { "delete", 0x2E },
        { "home", 0x24 }, { "end", 0x23 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
        { "pageup", 0x21 }, { "pagedown", 0x22 }, { "space", 0x20 }, { "insert", 0x2D }, { "del", 0x2E },
        { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "win", 0x5B }, { "windows", 0x5B },
        { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 },
        { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B },
        { "plus", 0xBB }, { "=", 0xBB }, { "minus", 0xBD }, { "-", 0xBD }, { ",", 0xBC }, { ".", 0xBE }, { "/", 0xBF },
        { ";", 0xBA }, { "[", 0xDB }, { "]", 0xDD }, { "\\", 0xDC }, { "'", 0xDE }, { "`", 0xC0 },
    };
    static readonly HashSet<ushort> extendedKeys = new HashSet<ushort> { 0x2E, 0x24, 0x23, 0x26, 0x28, 0x25, 0x27, 0x21, 0x22, 0x2D, 0x5B };

    static INPUT Key(ushort vk, ushort scan, uint flags)
    {
        if (extendedKeys.Contains(vk)) flags |= KEY_EXTENDED;
        return new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } } };
    }

    static void Send(List<INPUT> inputs)
    {
        if (inputs.Count > 0) SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(15);
    }

    // anyAppWindow (Do it mode): the keys may also go to one of the app's menus or dialogs in front, not only its window.
    static Dictionary<string, object> PressKeys(IntPtr hwnd, System.Collections.IEnumerable keys, bool anyAppWindow)
    {
        if (keys == null) return Error(null, "no keys");
        HashSet<uint> pids = anyAppWindow && hwnd != IntPtr.Zero ? AppPids(hwnd) : null;
        foreach (object item in keys)
        {
            IntPtr front = GetForegroundWindow();
            if (hwnd == IntPtr.Zero || (front != hwnd && (pids == null || !pids.Contains(PidOf(front))))) return Error(null, "the app is not in front");
            string key = Convert.ToString(item);
            if (key.StartsWith("wait:")) { Thread.Sleep(Math.Min(2000, int.Parse(key.Substring(5)))); continue; }
            var inputs = new List<INPUT>();
            if (key.StartsWith("text:"))
            {
                foreach (char c in key.Substring(5))
                {
                    inputs.Add(Key(0, c, KEY_UNICODE));
                    inputs.Add(Key(0, c, KEY_UNICODE | KEY_UP));
                }
                Send(inputs);
                continue;
            }
            var parts = key.ToLowerInvariant().Split('+');
            var codes = new List<ushort>();
            foreach (string part in parts)
            {
                ushort code;
                if (keyCodes.TryGetValue(part, out code)) codes.Add(code);
                else if (part.Length == 1 && char.IsLetterOrDigit(part[0])) codes.Add((ushort)char.ToUpperInvariant(part[0]));
                else return Error(null, "unknown key: " + part);
            }
            foreach (ushort code in codes) inputs.Add(Key(code, 0, 0));
            for (int i = codes.Count - 1; i >= 0; i--) inputs.Add(Key(codes[i], 0, KEY_UP));
            Send(inputs);
        }
        return new Dictionary<string, object> { { "ok", true } };
    }

    // Do it mode: Lefty clicks and types for the user, with the same real mouse and keyboard input a person makes (so
    // every app reacts as it does to a person). Each action first checks that the point belongs to the app the goal is
    // about (its window, or one of its menus and dialogs) and nothing else is in the way, and the mouse goes back to
    // where the user left it straight after.
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
    const uint GA_ROOT = 2;
    const uint INPUT_MOUSE = 0;
    const uint MOUSE_LEFTDOWN = 0x2, MOUSE_LEFTUP = 0x4, MOUSE_RIGHTDOWN = 0x8, MOUSE_RIGHTUP = 0x10, MOUSE_WHEEL = 0x800;
    const int ExpectDepth = 6; // the thing under the point may be a part of the expected one (a menu item's text)

    static uint PidOf(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid;
    }

    // The name of the program a window belongs to. Store apps (Calculator, Settings...) sit in a frame window owned by
    // ApplicationFrameHost, which hosts all of them; the app's own process draws inside it, and that is the name people
    // mean (and the one the private apps list must hold, or marking Calculator private would cover every Store app).
    static string ProcessNameOf(IntPtr hwnd)
    {
        uint pid = PidOf(hwnd);
        string name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        if (!string.Equals(name, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) return name;
        uint inner = 0;
        EnumChildWindows(hwnd, (child, _) => { uint p = PidOf(child); if (p != 0 && p != pid) { inner = p; return false; } return true; }, IntPtr.Zero);
        if (inner == 0) return name; // minimized: the app is not inside its frame right now
        try { return Process.GetProcessById((int)inner).ProcessName; } catch { return name; }
    }

    // Focus mode: the window in front. root is the window that owns it (an app's main window for its dialogs), so
    // a save prompt counts as part of its app. shell: the taskbar, Start, the desktop and Windows' passing screens.
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    const uint GA_ROOTOWNER = 3;
    const uint WM_CLOSE = 0x0010;
    const int SW_MINIMIZE = 6;

    static Dictionary<string, object> Front()
    {
        IntPtr hwnd = GetForegroundWindow();
        var reply = new Dictionary<string, object> { { "ok", true }, { "hwnd", 0L } };
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) { reply["shell"] = true; return reply; }
        IntPtr root = GetAncestor(hwnd, GA_ROOTOWNER);
        if (root == IntPtr.Zero) root = hwnd;
        var title = new StringBuilder(512);
        GetWindowText(root, title, title.Capacity);
        string cls = ClassOf(hwnd);
        uint pid = PidOf(hwnd);
        reply["hwnd"] = hwnd.ToInt64();
        reply["root"] = root.ToInt64();
        reply["title"] = Clip(title.ToString(), 200);
        reply["process"] = ProcessNameOf(root);
        reply["lefty"] = pid == (uint)leftyPid || pid == (uint)Process.GetCurrentProcess().Id;
        reply["shell"] = cls == "Progman" || cls == "WorkerW" || shellClasses.Contains(cls) || shellClasses.Contains(ClassOf(root));
        return reply;
    }

    static Dictionary<string, object> CloseWindow(IntPtr hwnd, bool minimize)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Error(null, "no such window");
        if (PidOf(hwnd) == (uint)leftyPid) return Error(null, "lefty");
        if (minimize) ShowWindow(hwnd, SW_MINIMIZE);
        else PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        return new Dictionary<string, object> { { "ok", true } };
    }

    // The processes that draw the app: its own, plus those of its child windows (a Store app like Calculator is drawn
    // by its own process inside a frame window that belongs to ApplicationFrameHost).
    static HashSet<uint> AppPids(IntPtr hwnd)
    {
        var pids = new HashSet<uint> { PidOf(hwnd) };
        EnumChildWindows(hwnd, (child, _) => { pids.Add(PidOf(child)); return pids.Count < 8; }, IntPtr.Zero);
        pids.Remove(0);
        return pids;
    }

    // Null when the point is the app's, else why not: "lefty" (Lefty's own bubble is there), "covered" (another app).
    static string WhoseIsPoint(IntPtr hwnd, HashSet<uint> pids, int x, int y)
    {
        IntPtr at = WindowFromPoint(new POINT { X = x, Y = y });
        if (at == IntPtr.Zero) return "covered";
        IntPtr root = GetAncestor(at, GA_ROOT);
        uint pid = PidOf(root);
        if (pid == (uint)leftyPid) return "lefty";
        if (root == hwnd || IsOwnedBy(root, hwnd) || pids.Contains(pid) || pids.Contains(PidOf(at))) return null;
        return "covered";
    }

    // The app (or its menu or dialog) must have the keyboard before Lefty acts: many apps ignore the first click on an
    // inactive window. Gives it focus if needed; false if Windows won't.
    static bool AppInFront(IntPtr hwnd, HashSet<uint> pids)
    {
        if (pids.Contains(PidOf(GetForegroundWindow()))) return true;
        Focus(hwnd);
        return pids.Contains(PidOf(GetForegroundWindow()));
    }

    // The name of the thing under the point, or of the nearest of its parents named expect (null: none of them is).
    static string NameAtPoint(int x, int y, string expect, out bool matches)
    {
        matches = false;
        IUIAutomationElement el;
        try { el = uia.ElementFromPoint(new tagPOINT { x = x, y = y }); }
        catch (COMException) { return null; }
        string first = null;
        IUIAutomationTreeWalker walker = uia.ControlViewWalker;
        for (int depth = 0; depth < ExpectDepth && el != null; depth++)
        {
            string name;
            try { name = (el.CurrentName ?? "").Trim(); } catch (COMException) { break; }
            if (first == null) first = name;
            if (expect != null && SameName(name, expect)) { matches = true; return name; }
            try { el = walker.GetParentElement(el); } catch (COMException) { break; }
        }
        return first;
    }

    // Names in a snapshot are cut at 120 characters, so a long one only has to start the same.
    static bool SameName(string name, string expect)
    {
        string want = expect.Trim();
        return string.Equals(name, want, StringComparison.OrdinalIgnoreCase)
            || (want.Length >= 100 && name.StartsWith(want, StringComparison.OrdinalIgnoreCase));
    }

    // Hit testing misses some popups (Notepad's Find bar answers with the text editor under it), so when the thing under
    // the point isn't the expected one, the app's windows are searched for an element of that name covering the point.
    static bool NamedElementCovers(IntPtr hwnd, int x, int y, string expect)
    {
        var cache = uia.CreateCacheRequest();
        cache.AddProperty(NameProperty);
        cache.AddProperty(BoundingRectangleProperty);
        cache.AutomationElementMode = AutomationElementMode.AutomationElementMode_None;
        var condition = uia.CreatePropertyConditionEx(NameProperty, expect.Trim(), PropertyConditionFlags.PropertyConditionFlags_IgnoreCase);
        foreach (IntPtr window in AppWindows(hwnd))
        {
            IUIAutomationElementArray found;
            try { found = uia.ElementFromHandle(window).FindAllBuildCache(TreeScope.TreeScope_Descendants, condition, cache); }
            catch (COMException) { continue; }
            for (int i = 0; found != null && i < found.Length; i++)
            {
                tagRECT r = found.GetElement(i).CachedBoundingRectangle;
                if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
            }
        }
        return false;
    }

    // Kinds of things under a point that aren't controls: a text area, a canvas, a panel.
    static readonly Dictionary<int, string> plainTypes = new Dictionary<int, string>
    {
        { 50033, "Pane" }, { 50032, "Window" }, { 50025, "Custom" }, { 50026, "Group" }, { 50020, "Text" }, { 50006, "Image" },
    };

    static Dictionary<string, object> Peek(int x, int y, bool clickable)
    {
        IUIAutomationElement el;
        try { el = uia.ElementFromPoint(new tagPOINT { x = x, y = y }); }
        catch (COMException) { return Error(null, "nothing there"); }
        if (el == null) return Error(null, "nothing there");
        if (clickable)
        {
            // What a person clicking here means: the nearest of the element and its parents that is a named control
            // (the menu item, not the text drawn inside it).
            IUIAutomationTreeWalker walker = uia.ControlViewWalker;
            IUIAutomationElement up = el;
            for (int depth = 0; depth < ExpectDepth && up != null; depth++)
            {
                string kind, label;
                try { label = (up.CurrentName ?? "").Trim(); }
                catch (COMException) { break; }
                if (label.Length > 0 && interactiveTypes.TryGetValue(SafeControlType(up), out kind)) { el = up; break; }
                try { up = walker.GetParentElement(up); } catch (COMException) { break; }
            }
        }
        string type, name;
        var reply = new Dictionary<string, object> { { "ok", true } };
        try
        {
            int id = el.CurrentControlType;
            if (!interactiveTypes.TryGetValue(id, out type) && !plainTypes.TryGetValue(id, out type)) type = "Other";
            name = Clip((el.CurrentName ?? "").Trim(), 120);
            if (clickable)
            {
                reply["rect"] = RectToDict(el.CurrentBoundingRectangle);
                reply["password"] = el.CurrentIsPassword != 0;
            }
        }
        catch (COMException) { return Error(null, "nothing there"); }
        reply["name"] = name;
        reply["type"] = type;
        if (clickable)
        {
            // The window there: which app was clicked, and where its window is (for spots without a name).
            IntPtr at = WindowFromPoint(new POINT { X = x, Y = y });
            IntPtr root = at == IntPtr.Zero ? IntPtr.Zero : GetAncestor(at, GA_ROOT);
            if (root != IntPtr.Zero)
            {
                string process = ProcessNameOf(root);
                var title = new StringBuilder(512);
                GetWindowText(root, title, title.Capacity);
                RECT wr;
                reply["process"] = process;
                reply["title"] = Clip(title.ToString(), 200);
                reply["lefty"] = PidOf(root) == (uint)leftyPid;
                if (GetWindowRect(root, out wr)) reply["windowRect"] = new Dictionary<string, object> { { "x", wr.Left }, { "y", wr.Top }, { "w", wr.Right - wr.Left }, { "h", wr.Bottom - wr.Top } };
            }
        }
        return reply;
    }

    static int SafeControlType(IUIAutomationElement el)
    {
        try { return el.CurrentControlType; } catch (COMException) { return 0; }
    }

    static INPUT Mouse(uint flags, int data)
    {
        return new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = flags, mouseData = (uint)data } } };
    }

    static Dictionary<string, object> Click(IntPtr hwnd, int x, int y, string button, int count, string expect)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Error(null, "no-window");
        var pids = AppPids(hwnd);
        string blocked = WhoseIsPoint(hwnd, pids, x, y);
        if (blocked != null) return Error(null, blocked);
        if (!AppInFront(hwnd, pids)) return Error(null, "not-front");
        bool matches;
        string found = NameAtPoint(x, y, string.IsNullOrEmpty(expect) ? null : expect, out matches);
        if (!string.IsNullOrEmpty(expect) && !matches && NamedElementCovers(hwnd, x, y, expect)) { matches = true; found = expect; }
        if (!string.IsNullOrEmpty(expect) && !matches)
        {
            var moved = Error(null, "moved");
            moved["found"] = found ?? "";
            return moved;
        }
        bool right = button == "right";
        POINT before;
        bool known = GetCursorPos(out before);
        SetCursorPos(x, y);
        Thread.Sleep(40); // the app sees the mouse arrive (hover) before the click, as with a person
        var inputs = new List<INPUT>();
        for (int i = 0; i < Math.Max(1, Math.Min(2, count)); i++)
        {
            inputs.Add(Mouse(right ? MOUSE_RIGHTDOWN : MOUSE_LEFTDOWN, 0));
            inputs.Add(Mouse(right ? MOUSE_RIGHTUP : MOUSE_LEFTUP, 0));
        }
        SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(30);
        if (known) SetCursorPos(before.X, before.Y);
        var reply = new Dictionary<string, object> { { "ok", true } };
        reply["found"] = found ?? "";
        return reply;
    }

    static Dictionary<string, object> Scroll(IntPtr hwnd, int x, int y, int notches)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Error(null, "no-window");
        var pids = AppPids(hwnd);
        string blocked = WhoseIsPoint(hwnd, pids, x, y);
        if (blocked != null) return Error(null, blocked);
        if (!AppInFront(hwnd, pids)) return Error(null, "not-front");
        POINT before;
        bool known = GetCursorPos(out before);
        SetCursorPos(x, y);
        Thread.Sleep(40);
        int clamped = Math.Max(-10, Math.Min(10, notches));
        SendInput(1, new[] { Mouse(MOUSE_WHEEL, clamped * 120) }, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(30);
        if (known) SetCursorPos(before.X, before.Y);
        return new Dictionary<string, object> { { "ok", true } };
    }

    // Types into whatever has the keyboard in the app (Lefty clicked the box first). Never into a password box: those
    // are the user's to fill.
    static Dictionary<string, object> TypeText(IntPtr hwnd, string text)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Error(null, "no-window");
        var pids = AppPids(hwnd);
        if (!pids.Contains(PidOf(GetForegroundWindow()))) return Error(null, "not-front");
        try
        {
            IUIAutomationElement focused = uia.GetFocusedElement();
            if (focused != null && focused.CurrentIsPassword != 0) return Error(null, "password");
        }
        catch (COMException) { }
        // One character per SendInput, a moment apart: modern text boxes (Notepad's, WinUI's) read a batch of typed
        // characters late and repeat the last one ("abc def" came out as "abc fff").
        int size = Marshal.SizeOf(typeof(INPUT));
        foreach (char c in text)
        {
            if (c == '\r') continue;
            if (!pids.Contains(PidOf(GetForegroundWindow()))) return Error(null, "not-front"); // the user switched away
            INPUT[] pair;
            if (c == '\n' || c == '\t')
            {
                ushort vk = c == '\n' ? (ushort)0x0D : (ushort)0x09;
                pair = new[] { Key(vk, 0, 0), Key(vk, 0, KEY_UP) };
            }
            else
            {
                pair = new[] { Key(0, c, KEY_UNICODE), Key(0, c, KEY_UNICODE | KEY_UP) };
            }
            SendInput(2, pair, size);
            Thread.Sleep(c == ' ' ? 25 : 10); // a word just ended: spell checkers and suggestions look at it
        }
        Thread.Sleep(15);
        return new Dictionary<string, object> { { "ok", true } };
    }

    // Apps built on Chromium (VS Code, Teams, Slack...) refuse UI Automation calls for a moment while their screen
    // is changing, e.g. right after a menu item is clicked (COM error 0x80040201). A moment later the same read
    // works, so a failed read is tried again before it counts as "can't read this app".
    const int SnapshotTries = 3;
    const int SnapshotRetryMs = 150;

    static Dictionary<string, object> SnapshotWithRetry(IntPtr hwnd)
    {
        for (int attempt = 1; ; attempt++)
        {
            try
            {
                var reply = Snapshot(hwnd);
                bool emptyAfterError = reply.ContainsKey("elements") && ((List<object>)reply["elements"]).Count == 0 && reply.ContainsKey("skipError") && reply["skipError"] != null;
                if (!emptyAfterError || attempt >= SnapshotTries) return reply;
            }
            catch (COMException)
            {
                if (attempt >= SnapshotTries) throw;
            }
            Thread.Sleep(SnapshotRetryMs);
        }
    }

    static Dictionary<string, object> Snapshot(IntPtr hwnd)
    {
        var timer = Stopwatch.StartNew();
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Error(null, "no app window found");

        string processName = ProcessNameOf(hwnd);
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
