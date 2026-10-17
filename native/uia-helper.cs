// Lefty's eyes: reads the clickable parts of the app the user is working in, using Windows UI Automation.
// Runs as a long-lived child of the Electron app. One JSON request per stdin line, one JSON reply per stdout line.
//
//   {"id":1,"cmd":"snapshot"}              -> elements of the last app the user was in (never Lefty itself)
//   {"id":2,"cmd":"snapshot","hwnd":1234}  -> elements of a specific window (used by tests)
//
// Rectangles are physical screen pixels; Electron converts them to its own units (DIPs).
// Built with the C# 5 compiler that ships with Windows (.NET Framework 4), so no install is needed.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

static class UiaHelper
{
    const int MaxElements = 400;
    const int SnapshotBudgetMs = 4000;

    static int leftyPid;                   // Electron main process: owns Lefty's windows
    static IntPtr lastUserWindow = IntPtr.Zero;
    static readonly object windowLock = new object();
    static readonly object writeLock = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    static readonly HashSet<int> interactiveTypes = new HashSet<int>
    {
        ControlType.Button.Id, ControlType.SplitButton.Id, ControlType.MenuItem.Id, ControlType.TabItem.Id,
        ControlType.ListItem.Id, ControlType.TreeItem.Id, ControlType.Hyperlink.Id, ControlType.CheckBox.Id,
        ControlType.RadioButton.Id, ControlType.ComboBox.Id, ControlType.Edit.Id, ControlType.Slider.Id,
        ControlType.DataItem.Id, ControlType.HeaderItem.Id, ControlType.Spinner.Id, ControlType.Document.Id,
    };

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

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
                if ((cmd as string) == "snapshot")
                {
                    object hwnd;
                    IntPtr target = request.TryGetValue("hwnd", out hwnd) && hwnd != null
                        ? new IntPtr(Convert.ToInt64(hwnd))
                        : UserWindow();
                    var reply = Snapshot(target);
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
        if (hwnd == IntPtr.Zero) return false;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid != 0 && pid != (uint)leftyPid && pid != (uint)Process.GetCurrentProcess().Id;
    }

    static IntPtr UserWindow()
    {
        IntPtr now = GetForegroundWindow();
        if (IsUserWindow(now)) return now;
        lock (windowLock) return lastUserWindow;
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

        var root = AutomationElement.FromHandle(hwnd);
        var rootRect = root.Current.BoundingRectangle;

        // Fetch all needed properties in one cross-process call instead of one call per property.
        var cache = new CacheRequest();
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.BoundingRectangleProperty);
        cache.Add(AutomationElement.AutomationIdProperty);
        cache.Add(AutomationElement.IsEnabledProperty);
        cache.Add(AutomationElement.IsOffscreenProperty);
        cache.AutomationElementMode = AutomationElementMode.None;

        var condition = new AndCondition(
            new PropertyCondition(AutomationElement.IsControlElementProperty, true),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false));

        AutomationElementCollection found;
        using (cache.Activate()) found = root.FindAll(TreeScope.Descendants, condition);

        var elements = new List<object>();
        bool truncated = false;
        foreach (AutomationElement el in found)
        {
            if (elements.Count >= MaxElements || timer.ElapsedMilliseconds > SnapshotBudgetMs) { truncated = true; break; }
            var type = (ControlType)el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
            if (type == null || !interactiveTypes.Contains(type.Id)) continue;
            var r = (System.Windows.Rect)el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
            if (r.IsEmpty || r.Width < 2 || r.Height < 2) continue;

            elements.Add(new Dictionary<string, object>
            {
                { "i", elements.Count },
                { "name", Clip((string)el.GetCachedPropertyValue(AutomationElement.NameProperty), 120) },
                { "type", type.ProgrammaticName.Replace("ControlType.", "") },
                { "id", Clip((string)el.GetCachedPropertyValue(AutomationElement.AutomationIdProperty), 80) },
                { "enabled", (bool)el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty) },
                { "rect", RectToDict(r) },
            });
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
            { "truncated", truncated },
            { "ms", timer.ElapsedMilliseconds },
        };
    }

    static Dictionary<string, object> RectToDict(System.Windows.Rect r)
    {
        if (r.IsEmpty) return null;
        return new Dictionary<string, object>
        {
            { "x", (int)Math.Round(r.X) }, { "y", (int)Math.Round(r.Y) },
            { "w", (int)Math.Round(r.Width) }, { "h", (int)Math.Round(r.Height) },
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
