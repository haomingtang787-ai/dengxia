// DeskOfficeSandbox: the Windows execution layer for untrusted Office conversion.
//
// Three modes:
//   selftest  create an AppContainer, run the probe inside it, and report whether
//             file reads outside the grant and network egress are actually denied.
//   run       launch a target executable inside the same container and job object.
//   probe     the payload that runs inside the container (never called directly).
//
// The container has no capabilities, so it has no internetClient and no
// privateNetworkClientServer: network is blocked by the AppContainer rather than
// by a host firewall rule, which would need administrator rights.
//
// Reports are line-based key=value, so the caller needs no JSON parser.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class Program
{
    private const string ContainerName = "DeskOfficeSandbox";

    private static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0] : "";
        Dictionary<string, string> options = ParseOptions(args, 1);
        try
        {
            if (mode == "probe")
            {
                return RunProbe(options);
            }
            if (mode == "selftest")
            {
                return RunSelfTest(options);
            }
            if (mode == "run")
            {
                return RunTarget(options);
            }
            Console.WriteLine("status=invalid-mode");
            return 2;
        }
        catch (Exception error)
        {
            Console.WriteLine("status=error");
            Console.WriteLine("detail=" + Flatten(error));
            return 3;
        }
    }

    // ---------------------------------------------------------------- probe

    private static int RunProbe(Dictionary<string, string> options)
    {
        StringBuilder report = new StringBuilder();
        report.AppendLine("probe=ran");

        string read = Value(options, "read");
        if (read != null)
        {
            try
            {
                File.ReadAllText(read);
                report.AppendLine("read=readable");
            }
            catch (UnauthorizedAccessException)
            {
                report.AppendLine("read=denied");
            }
            catch (Exception error)
            {
                report.AppendLine("read=" + error.GetType().Name);
            }
        }

        string tcp = Value(options, "tcp");
        if (tcp != null)
        {
            string[] parts = tcp.Split(':');
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    client.Connect(parts[0], int.Parse(parts[1]));
                    client.Close();
                }
                report.AppendLine("tcp=connected");
            }
            catch (Exception error)
            {
                report.AppendLine("tcp=" + ClassifyNetwork(error));
            }
        }

        string write = Value(options, "write");
        if (write != null)
        {
            try
            {
                File.WriteAllText(write, "probe");
                report.AppendLine("write=allowed");
            }
            catch (UnauthorizedAccessException)
            {
                report.AppendLine("write=denied");
            }
            catch (Exception error)
            {
                report.AppendLine("write=" + error.GetType().Name);
            }
        }

        string alloc = Value(options, "alloc");
        if (alloc != null)
        {
            int megabytes = int.Parse(alloc);
            try
            {
                byte[] buffer = new byte[megabytes * 1024 * 1024];
                buffer[0] = 1;
                buffer[buffer.Length - 1] = 1;
                report.AppendLine("alloc=ok");
            }
            catch (OutOfMemoryException)
            {
                report.AppendLine("alloc=limited");
            }
        }

        if (Value(options, "dump-env") != null)
        {
            int count = 0;
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                report.AppendLine("env." + entry.Key + "=" + entry.Value);
                count++;
            }
            report.AppendLine("env.count=" + count);
        }

        string heartbeat = Value(options, "heartbeat");
        if (heartbeat != null)
        {
            try
            {
                File.AppendAllText(heartbeat, "beat\n");
                report.AppendLine("heartbeat=allowed");
            }
            catch (Exception error)
            {
                report.AppendLine("heartbeat=" + error.GetType().Name);
            }
        }

        // Keeps writing for a while, so the caller can prove the process tree
        // was actually killed rather than having exited on its own.
        string keepAlive = Value(options, "keep-alive");
        if (keepAlive != null)
        {
            int seconds = int.Parse(Value(options, "seconds") ?? "30");
            Stopwatch watch = Stopwatch.StartNew();
            try
            {
                while (watch.Elapsed < TimeSpan.FromSeconds(seconds))
                {
                    File.AppendAllText(keepAlive, "beat\n");
                    Thread.Sleep(180);
                }
                report.AppendLine("keepalive=finished");
            }
            catch (Exception error)
            {
                report.AppendLine("keepalive=" + error.GetType().Name);
            }
        }

        string spawn = Value(options, "spawn-keep-alive");
        if (spawn != null)
        {
            try
            {
                string self = Environment.GetCommandLineArgs()[0];
                int seconds = int.Parse(Value(options, "seconds") ?? "30");
                Process child = new Process();
                child.StartInfo.FileName = self;
                child.StartInfo.Arguments = "probe --keep-alive \"" + spawn + "\" --seconds " + seconds + " --quiet";
                child.StartInfo.UseShellExecute = false;
                child.StartInfo.CreateNoWindow = true;
                child.Start();
                report.AppendLine("spawn=started");
                report.AppendLine("childpid=" + child.Id);
            }
            catch (Exception error)
            {
                report.AppendLine("spawn=" + error.GetType().Name);
            }
        }

        string output = Value(options, "out");
        if (output != null)
        {
            File.WriteAllText(output, report.ToString());
        }
        if (Value(options, "quiet") == null)
        {
            Console.Write(report.ToString());
        }
        return 0;
    }

    private static string ClassifyNetwork(Exception error)
    {
        if (error is SocketException)
        {
            SocketException socket = (SocketException)error;
            return "blocked-" + socket.SocketErrorCode;
        }
        if (error is UnauthorizedAccessException)
        {
            return "blocked-access";
        }
        return "blocked-" + error.GetType().Name;
    }

    // ------------------------------------------------------------- selftest

    private static int RunSelfTest(Dictionary<string, string> options)
    {
        string work = Require(options, "work");
        string keep = Value(options, "keep");
        string reportPath = Value(options, "report");
        StringBuilder report = new StringBuilder();

        string granted = Path.Combine(work, "granted");
        string denied = Path.Combine(work, "denied");
        Directory.CreateDirectory(granted);
        Directory.CreateDirectory(denied);

        string secret = Path.Combine(denied, "secret.txt");
        File.WriteAllText(secret, "outside-the-grant");

        string containerSid = EnsureContainer(report);
        report.AppendLine("container=" + containerSid);

        string self = Environment.GetCommandLineArgs()[0];
        string probeExe = Path.Combine(granted, "probe.exe");
        File.Copy(self, probeExe, true);

        GrantContainer(granted, containerSid, true);
        SetLowIntegrity(granted);

        string resultFile = Path.Combine(granted, "probe-result.txt");
        string heartbeatFile = Path.Combine(granted, "heartbeat.txt");
        string grandHeartbeat = Path.Combine(granted, "grandchild-heartbeat.txt");
        if (File.Exists(resultFile))
        {
            File.Delete(resultFile);
        }

        int port = 0;
        TcpListener listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            port = ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        catch (Exception error)
        {
            report.AppendLine("listener=failed-" + error.GetType().Name);
        }

        IntPtr job = CreateLimitedJob(512);
        report.AppendLine("job=" + (job != IntPtr.Zero ? "created" : "failed"));

        string arguments =
            "probe --out \"" + resultFile + "\""
            + " --read \"" + secret + "\""
            + " --write \"" + Path.Combine(granted, "write.txt") + "\""
            + " --heartbeat \"" + heartbeatFile + "\""
            + " --alloc 700"
            + (port > 0 ? " --tcp 127.0.0.1:" + port : "")
            + " --spawn-keep-alive \"" + grandHeartbeat + "\" --seconds 30";

        LaunchResult launched = LaunchInContainer(probeExe, arguments, granted, containerSid, job, Path.Combine(granted, "probe-stdout.txt"), Path.Combine(granted, "probe-stderr.txt"));
        report.AppendLine("launch=" + launched.Status);
        if (launched.Detail != null)
        {
            report.AppendLine("launchDetail=" + launched.Detail);
        }

        string probeReport = null;
        if (launched.Status == "ok")
        {
            probeReport = WaitForReport(resultFile, 30000);
            report.AppendLine("probeReport=" + (probeReport == null ? "missing" : "read"));
        }

        // Process-tree lifecycle: the grandchild has to be demonstrably alive
        // and writing before the job is killed, otherwise "it stopped" proves
        // nothing at all.
        bool treeKilled = false;
        long before = 0;
        long running = 0;
        long afterKill = 0;
        long settled = 0;
        if (job != IntPtr.Zero)
        {
            Stopwatch live = Stopwatch.StartNew();
            while (live.ElapsedMilliseconds < 4000 && SizeOrZero(grandHeartbeat) == 0)
            {
                Thread.Sleep(100);
            }
            before = SizeOrZero(grandHeartbeat);
            Thread.Sleep(500);
            running = SizeOrZero(grandHeartbeat);
            TerminateJobObject(job, 1);
            Thread.Sleep(900);
            afterKill = SizeOrZero(grandHeartbeat);
            Thread.Sleep(1200);
            settled = SizeOrZero(grandHeartbeat);
            treeKilled = before > 0 && running > before && settled == afterKill;
        }
        report.AppendLine("treeHeartbeatBefore=" + before);
        report.AppendLine("treeHeartbeatRunning=" + running);
        report.AppendLine("treeHeartbeatAfterKill=" + afterKill);
        report.AppendLine("treeHeartbeatSettled=" + settled);
        report.AppendLine("treeKilled=" + (treeKilled ? "yes" : "no"));

        if (probeReport != null)
        {
            foreach (string line in probeReport.Split('\n'))
            {
                string trimmed = line.Trim();
                if (trimmed.Length > 0)
                {
                    report.AppendLine("probe." + trimmed);
                }
            }
        }
        if (listener != null)
        {
            listener.Stop();
        }
        if (job != IntPtr.Zero)
        {
            CloseHandle(job);
        }
        if (keep == null)
        {
            // Leave the directory behind only when asked; the caller owns cleanup.
        }
        if (reportPath != null)
        {
            File.WriteAllText(reportPath, report.ToString());
        }
        Console.Write(report.ToString());
        return 0;
    }

    private static string WaitForReport(string path, int timeoutMs)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            if (File.Exists(path))
            {
                try
                {
                    string text = File.ReadAllText(path);
                    if (text.Contains("probe=ran"))
                    {
                        return text;
                    }
                }
                catch (IOException)
                {
                    // still being written
                }
            }
            Thread.Sleep(120);
        }
        return null;
    }

    private static long SizeOrZero(string path)
    {
        try
        {
            return new FileInfo(path).Length;
        }
        catch (IOException)
        {
            return 0;
        }
    }

    // ------------------------------------------------------------------ run

    private static int RunTarget(Dictionary<string, string> options)
    {
        string exe = Require(options, "exe");
        string work = Require(options, "work");
        string argsFile = Require(options, "args-file");
        string timeoutText = Value(options, "timeout-ms") ?? "90000";
        int timeoutMs = int.Parse(timeoutText);

        List<string> extra = new List<string>();
        foreach (string line in File.ReadAllLines(argsFile))
        {
            extra.Add(line);
        }

        Directory.CreateDirectory(work);
        string containerSid = EnsureContainer(null);
        GrantContainer(work, containerSid, true);
        SetLowIntegrity(work);
        GrantReadOnly(Path.GetDirectoryName(exe), containerSid);

        IntPtr job = CreateLimitedJob(1536);
        string arguments = JoinQuoted(extra);
        // The child has no console of its own: without explicit handles its
        // stdout and stderr go nowhere, which is how a real failure turns into
        // an unexplained exit code. Capture both next to the work directory so
        // the caller can report what LibreOffice actually said.
        string childOut = Path.Combine(work, "child-stdout.txt");
        string childErr = Path.Combine(work, "child-stderr.txt");
        LaunchResult launched = LaunchInContainer(exe, arguments, work, containerSid, job, childOut, childErr);
        Console.WriteLine("launch=" + launched.Status);
        if (launched.Detail != null)
        {
            Console.WriteLine("launchDetail=" + launched.Detail);
            return 4;
        }

        int exitCode = WaitForExit(launched.Process, timeoutMs);
        bool timedOut = exitCode == int.MinValue;
        Console.WriteLine("timedOut=" + (timedOut ? "yes" : "no"));
        if (timedOut)
        {
            TerminateJobObject(job, 1);
            WaitForExit(launched.Process, 5000);
        }
        Console.WriteLine("exit=" + (timedOut ? -1 : exitCode));
        CloseHandle(job);
        return timedOut ? 5 : 0;
    }

    private static int WaitForExit(IntPtr process, int timeoutMs)
    {
        IntPtr[] handles = new IntPtr[] { process };
        uint waited = WaitForMultipleObjects(1, handles, false, (uint)timeoutMs);
        if (waited != 0)
        {
            return int.MinValue;
        }
        uint code;
        GetExitCodeProcess(process, out code);
        return (int)code;
    }

    // ------------------------------------------------------------ container

    private static string EnsureContainer(StringBuilder report)
    {
        IntPtr sid;
        int result = CreateAppContainerProfile(ContainerName, "Desk Office Sandbox", "Restricted Office conversion", IntPtr.Zero, 0, out sid);
        if (result == unchecked((int)0x800700B7) || result == unchecked((int)0x80070005))
        {
            int derived = DeriveAppContainerSidFromAppContainerName(ContainerName, out sid);
            if (derived < 0)
            {
                throw new InvalidOperationException("derive-container-sid failed 0x" + derived.ToString("X8"));
            }
            if (report != null)
            {
                report.AppendLine("containerMode=" + (result == unchecked((int)0x80070005) ? "denied" : "reused"));
            }
        }
        else if (result < 0)
        {
            throw new InvalidOperationException("create-container failed 0x" + result.ToString("X8"));
        }
        string text = SidToString(sid);
        FreeSid(sid);
        return text;
    }

    private static void GrantContainer(string directory, string sidString, bool writable)
    {
        SecurityIdentifier sid = new SecurityIdentifier(sidString);
        DirectorySecurity security = Directory.GetAccessControl(directory);
        FileSystemRights rights = writable ? FileSystemRights.FullControl : FileSystemRights.ReadAndExecute;
        security.AddAccessRule(new FileSystemAccessRule(
            sid,
            rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        Directory.SetAccessControl(directory, security);
    }

    private static void GrantReadOnly(string directory, string sidString)
    {
        if (directory == null)
        {
            return;
        }
        GrantContainer(directory, sidString, false);
    }

    // A low-integrity label is what lets the AppContainer write at all: the
    // container token runs at low integrity, and a medium-integrity directory
    // would refuse writes regardless of the DACL above.
    private static void SetLowIntegrity(string directory)
    {
        IntPtr descriptor;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;;NW;;;LW)", 1, out descriptor, IntPtr.Zero))
        {
            throw new InvalidOperationException("label-sddl failed");
        }
        try
        {
            uint applied = SetNamedSecurityInfoW(directory, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, descriptor);
            if (applied != 0)
            {
                throw new InvalidOperationException("label-apply failed " + applied);
            }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    private static IntPtr CreateLimitedJob(int memoryMegabytes)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags =
            0x2000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | 0x100 // JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | 0x200 // JOB_OBJECT_LIMIT_JOB_MEMORY
            | 0x8;  // JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        limits.BasicLimitInformation.ActiveProcessLimit = 6;
        limits.ProcessMemoryLimit = (UIntPtr)((ulong)memoryMegabytes * 1024UL * 1024UL);
        limits.JobMemoryLimit = (UIntPtr)((ulong)memoryMegabytes * 2UL * 1024UL * 1024UL);

        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, 9, buffer, (uint)size))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    private static LaunchResult LaunchInContainer(string exe, string arguments, string workingDirectory, string containerSid, IntPtr job, string stdoutPath, string stderrPath)
    {
        // lpCommandLine must begin with the executable: the child's first
        // token is taken as the program name, and everything after it becomes
        // argv. Omitting the exe silently shifts every argument by one.
        string commandLine = Quote(exe) + (arguments.Length > 0 ? " " + arguments : "");
        IntPtr inputHandle = IntPtr.Zero;
        IntPtr outputHandle = IntPtr.Zero;
        IntPtr errorHandle = IntPtr.Zero;
        IntPtr sid;
        if (DeriveAppContainerSidFromAppContainerName(ContainerName, out sid) < 0)
        {
            return new LaunchResult("derive-failed", IntPtr.Zero, null);
        }

        IntPtr attributeList = IntPtr.Zero;
        IntPtr capabilities = IntPtr.Zero;
        IntPtr size = IntPtr.Zero;
        try
        {
            inputHandle = OpenNullHandle();
            outputHandle = CreateStdHandle(stdoutPath);
            errorHandle = CreateStdHandle(stderrPath);
            bool first = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (first || size == IntPtr.Zero)
            {
                return new LaunchResult("attr-size-failed", IntPtr.Zero, null);
            }
            attributeList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size))
            {
                return new LaunchResult("attr-init-failed", IntPtr.Zero, null);
            }

            capabilities = Marshal.AllocHGlobal(IntPtr.Size * 2 + 8);
            Marshal.WriteIntPtr(capabilities, 0, sid);
            Marshal.WriteIntPtr(capabilities, IntPtr.Size, IntPtr.Zero);
            Marshal.WriteInt32(capabilities, IntPtr.Size * 2, 0);
            Marshal.WriteInt32(capabilities, IntPtr.Size * 2 + 4, 0);

            if (!UpdateProcThreadAttribute(attributeList, 0, (IntPtr)0x20009, capabilities, (IntPtr)(IntPtr.Size * 2 + 8), IntPtr.Zero, IntPtr.Zero))
            {
                return new LaunchResult("attr-update-failed", IntPtr.Zero, null);
            }

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
            startup.StartupInfo.hStdInput = inputHandle;
            startup.StartupInfo.hStdOutput = outputHandle;
            startup.StartupInfo.hStdError = errorHandle;
            startup.lpAttributeList = attributeList;

            PROCESS_INFORMATION info;
            bool created = CreateProcessW(
                exe,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                0x00080000, // EXTENDED_STARTUPINFO_PRESENT
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out info);
            if (!created)
            {
                int error = Marshal.GetLastWin32Error();
                return new LaunchResult("create-failed", IntPtr.Zero, "win32=" + error);
            }

            if (job != IntPtr.Zero)
            {
                AssignProcessToJobObject(job, info.hProcess);
            }
            CloseHandle(info.hThread);
            return new LaunchResult("ok", info.hProcess, null);
        }
        finally
        {
            if (inputHandle != IntPtr.Zero)
            {
                CloseHandle(inputHandle);
            }
            if (outputHandle != IntPtr.Zero)
            {
                CloseHandle(outputHandle);
            }
            if (errorHandle != IntPtr.Zero)
            {
                CloseHandle(errorHandle);
            }
            if (capabilities != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(capabilities);
            }
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            FreeSid(sid);
        }
    }

    // CreateFileW returns -1 (INVALID_HANDLE_VALUE) on failure, not zero, so a
    // plain "handle == 0" test would happily close an invalid handle.
    private static IntPtr CreateStdHandle(string path)
    {
        if (path == null)
        {
            return IntPtr.Zero;
        }
        const uint GENERIC_WRITE = 0x40000000;
        const uint FILE_SHARE_ALL = 3;
        const uint CREATE_ALWAYS = 2;
        const uint FILE_ATTRIBUTE_NORMAL = 0x80;
        IntPtr handle = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_ALL, IntPtr.Zero, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == new IntPtr(-1))
        {
            return IntPtr.Zero;
        }
        SetHandleInformation(handle, 1, 1); // HANDLE_FLAG_INHERIT
        return handle;
    }

    private static IntPtr OpenNullHandle()
    {
        const uint GENERIC_WRITE = 0x40000000;
        const uint FILE_SHARE_ALL = 3;
        const uint OPEN_EXISTING = 3;
        const uint FILE_ATTRIBUTE_NORMAL = 0x80;
        IntPtr handle = CreateFileW("NUL", GENERIC_WRITE, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == new IntPtr(-1))
        {
            return IntPtr.Zero;
        }
        SetHandleInformation(handle, 1, 1);
        return handle;
    }

    private sealed class LaunchResult
    {
        public LaunchResult(string status, IntPtr process, string detail)
        {
            Status = status;
            Process = process;
            Detail = detail;
        }

        public string Status { get; private set; }
        public IntPtr Process { get; private set; }
        public string Detail { get; private set; }
    }

    // -------------------------------------------------------------- helpers

    private static Dictionary<string, string> ParseOptions(string[] args, int start)
    {
        Dictionary<string, string> options = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int index = start; index < args.Length; index++)
        {
            string token = args[index];
            if (!token.StartsWith("--"))
            {
                continue;
            }
            string value = index + 1 < args.Length && !args[index + 1].StartsWith("--") ? args[++index] : "1";
            options[token.Substring(2)] = value;
        }
        return options;
    }

    private static string Value(Dictionary<string, string> options, string key)
    {
        string value;
        return options.TryGetValue(key, out value) ? value : null;
    }

    private static string Require(Dictionary<string, string> options, string key)
    {
        string value = Value(options, key);
        if (value == null)
        {
            throw new InvalidOperationException("missing --" + key);
        }
        return value;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string JoinQuoted(List<string> values)
    {
        StringBuilder builder = new StringBuilder();
        foreach (string value in values)
        {
            if (builder.Length > 0)
            {
                builder.Append(' ');
            }
            builder.Append(Quote(value));
        }
        return builder.ToString();
    }

    private static string Flatten(Exception error)
    {
        StringBuilder builder = new StringBuilder();
        Exception current = error;
        while (current != null)
        {
            if (builder.Length > 0)
            {
                builder.Append(" <- ");
            }
            builder.Append(current.GetType().Name).Append(": ").Append(current.Message);
            current = current.InnerException;
        }
        return builder.ToString().Replace("\r", " ").Replace("\n", " ");
    }

    private static string SidToString(IntPtr sid)
    {
        IntPtr text;
        if (!ConvertSidToStringSidW(sid, out text))
        {
            throw new InvalidOperationException("sid-to-string failed");
        }
        try
        {
            return Marshal.PtrToStringUni(text);
        }
        finally
        {
            LocalFree(text);
        }
    }

    // ------------------------------------------------------------- interop

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    private static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SetNamedSecurityInfoW(string name, int objectType, int securityInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string applicationName, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
}
