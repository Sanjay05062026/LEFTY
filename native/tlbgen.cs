// Generates a .NET interop assembly for native UI Automation from the type library inside UIAutomationCore.dll
// (what tlbimp does, using the converter built into .NET Framework). Usage: tlbgen <UIAutomationCore.dll> <out.dll>
using System;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

class Sink : ITypeLibImporterNotifySink
{
    public void ReportEvent(ImporterEventKind kind, int code, string message) { if (kind == ImporterEventKind.ERROR_REFTOINVALIDTYPELIB) Console.Error.WriteLine(message); }
    public Assembly ResolveRef(object typeLib) { throw new Exception("unexpected type library reference"); }
}

static class TlbGen
{
    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void LoadTypeLibEx(string file, int regKind, out ITypeLib typeLib);

    static int Main(string[] args)
    {
        ITypeLib lib;
        LoadTypeLibEx(args[0], 2 /* REGKIND_NONE */, out lib);
        string outPath = Path.GetFullPath(args[1]);
        var builder = (AssemblyBuilder)new TypeLibConverter().ConvertTypeLibToAssembly(
            lib, outPath, TypeLibImporterFlags.SafeArrayAsSystemArray, new Sink(), null, null, "Interop.UIAutomationClient", null);
        builder.Save(Path.GetFileName(outPath));
        Console.WriteLine("wrote " + outPath);
        return 0;
    }
}
