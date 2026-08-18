using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class ZinraSetup
{
    [STAThread]
    private static void Main()
    {
        try
        {
            var source = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            if (!File.Exists(Path.Combine(source, "manifest.json")))
            {
                MessageBox.Show(
                    "Run ZinraSetup.exe from inside the Zinra folder (the one that contains manifest.json).",
                    "Zinra",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            var dest = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Zinra");
            CopyExtension(source, dest);

            var chrome = FindChrome();
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var startMenu = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                "Programs");
            Directory.CreateDirectory(startMenu);

            if (chrome != null)
            {
                WriteShortcut(Path.Combine(desktop, "Zinra.lnk"), chrome, dest);
                WriteShortcut(Path.Combine(startMenu, "Zinra.lnk"), chrome, dest);
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = dest,
                UseShellExecute = true
            });

            if (chrome != null)
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = chrome,
                    Arguments = "chrome://extensions",
                    UseShellExecute = true
                });
            }

            MessageBox.Show(
                "Zinra is copied to:\n" + dest + "\n\n" +
                "In Chrome:\n" +
                "1. Turn on Developer mode (top right)\n" +
                "2. Click Load unpacked\n" +
                "3. Select that Zinra folder\n\n" +
                "A Zinra shortcut is on your desktop. The Chrome Web Store listing is the usual install for other people.",
                "Zinra installed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Zinra setup failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void CopyExtension(string source, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            var name = dir.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar);
            if (Skip(name)) continue;
            Directory.CreateDirectory(Path.Combine(dest, name));
        }
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var name = file.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar);
            if (Skip(name)) continue;
            var target = Path.Combine(dest, name);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.Copy(file, target, true);
        }
    }

    private static bool Skip(string relative)
    {
        var n = relative.Replace('/', '\\');
        if (n.StartsWith(".git", StringComparison.OrdinalIgnoreCase)) return true;
        if (n.StartsWith("installer", StringComparison.OrdinalIgnoreCase)) return true;
        if (n.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return true;
        if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return true;
        if (n.Equals("ZinraSetup.exe", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static string FindChrome()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
        };
        foreach (var path in candidates)
        {
            if (File.Exists(path)) return path;
        }
        return null;
    }

    private static void WriteShortcut(string linkPath, string chrome, string extensionDir)
    {
        var type = Type.GetTypeFromProgID("WScript.Shell");
        dynamic shell = Activator.CreateInstance(type);
        dynamic shortcut = shell.CreateShortcut(linkPath);
        shortcut.TargetPath = chrome;
        shortcut.Arguments = "--new-window";
        shortcut.WorkingDirectory = extensionDir;
        shortcut.Description = "Zinra — record a tab, punch in, export";
        var icon = Path.Combine(extensionDir, "icons", "icon128.png");
        if (File.Exists(icon)) shortcut.IconLocation = icon;
        shortcut.Save();
    }
}
