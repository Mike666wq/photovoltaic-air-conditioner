using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PvAc.Client;

// 仅主文档持有桥：不订阅 Frame.WebMessageReceived，不暴露宿主对象。
internal sealed class MainForm : Form
{
    private const string Origin = "https://pv-ac.bbben.xyz";
    private const string Home = Origin + "/";
    private const string Downloads = "https://github.com/Mike666wq/photovoltaic-air-conditioner/releases";
    private const string RuntimeDownload = "https://developer.microsoft.com/microsoft-edge/webview2/#download-section";
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly ToolStrip tools = new() { GripStyle = ToolStripGripStyle.Hidden };
    private readonly ToolStripLabel notice = new();
    private bool ready, closingConfirmed, closingBusy, navigating, saving;
    private bool foreground = true;
    private string retryUri = Home;
    private static bool Trusted(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && uri.Scheme == "https" && uri.Host == "pv-ac.bbben.xyz" && uri.Port == 443 && string.IsNullOrEmpty(uri.UserInfo);

    public MainForm()
    {
        Text = "光伏·空调监控";
        Width = 1280; Height = 850; MinimumSize = new Size(640, 480);
        Controls.Add(browser); Controls.Add(tools);
        AddButton("返回", async () => await Back());
        AddButton("刷新", async () => await NavigateGuarded(() => browser.Reload()));
        AddButton("原理图", async () => await NavigateModule("/"));
        AddButton("数据分析", async () => await NavigateModule("/analysis"));
        AddButton("实时监控", async () => await NavigateModule("/monitoring"));
        AddButton("关于", () => {
            var assembly = Assembly.GetExecutingAssembly();
            var sha = assembly.GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(x => x.Key == "BuildSha")?.Value;
            var shortSha = string.IsNullOrWhiteSpace(sha) ? "未知" : sha[..Math.Min(7, sha.Length)];
            if (MessageBox.Show(this, $"光伏·空调监控\n{assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion}\n提交：{shortSha}\n服务地址：{Home}\n下载：{Downloads}\n\n打开客户端下载页面？", "关于", MessageBoxButtons.YesNo) == DialogResult.Yes) OpenExternal(Downloads);
            return Task.CompletedTask;
        });
        AddButton("重试", async () => { if (!ready) await Initialize(); else await NavigateGuarded(() => browser.CoreWebView2.Navigate(retryUri)); });
        tools.Items.Add(notice);
        Shown += async (_, _) => await Initialize();
        Resize += async (_, _) =>
        {
            var next = WindowState != FormWindowState.Minimized;
            if (foreground == next) return;
            foreground = next;
            await CallBridge($"window.PvAcClient?.setForeground?.({(next ? "true" : "false")})");
        };
        FormClosing += async (_, e) =>
        {
            if (closingConfirmed) return;
            e.Cancel = true;
            if (closingBusy || saving) return;
            closingBusy = true;
            try
            {
                var hasPending = await CallBridge("window.PvAcClient?.canDiscard?.()") == "false";
                var prompt = hasPending ? "有未保存的内容，确定退出客户端？" : "确定退出客户端？";
                if (MessageBox.Show(this, prompt, "确认退出", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
                closingConfirmed = true;
                await CallBridge("window.PvAcClient?.setForeground?.(false)");
                Close();
            }
            finally { closingBusy = false; }
        };
    }

    private void AddButton(string text, Func<Task> action)
    {
        var button = new ToolStripButton(text);
        button.Click += async (_, _) => { try { await action(); } catch { notice.Text = "操作失败，请重试"; } };
        tools.Items.Add(button);
    }

    private async Task Initialize()
    {
        if (ready || navigating) return;
        navigating = true;
        try
        {
            // 使用独立用户目录保存 cookie；升级保持目录稳定。
            var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PvAcMonitor", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.NavigationStarting += (_, e) =>
            {
                if (Trusted(e.Uri)) { retryUri = e.Uri; return; }
                e.Cancel = true;
                OpenExternal(e.Uri);
            };
            core.FrameNavigationStarting += (_, e) => { if (!Trusted(e.Uri)) e.Cancel = true; };
            core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
            core.ServerCertificateErrorDetected += (_, e) => { e.Action = CoreWebView2ServerCertificateErrorAction.Cancel; };
            core.DownloadStarting += (_, e) => { e.Cancel = true; notice.Text = "请使用页面的保存功能导出文本"; };
            core.PermissionRequested += (_, e) => { e.State = CoreWebView2PermissionState.Deny; };
            core.WebMessageReceived += SaveMessage;
            core.NavigationCompleted += async (_, e) =>
            {
                notice.Text = e.IsSuccess ? "" : "加载失败，检查网络后点击重试";
                if (e.IsSuccess) await CallBridge($"window.PvAcClient?.setForeground?.({(foreground ? "true" : "false")})");
            };
            // 不创建替代错误网页，重试栏始终保留。
            ready = true;
            core.Navigate(Home);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            notice.Text = "缺少 WebView2 运行时";
            if (MessageBox.Show(this, "需要 Microsoft Evergreen WebView2 运行时。打开微软官网下载 Bootstrapper，安装后点击重试。", "安装运行时", MessageBoxButtons.OKCancel) == DialogResult.OK)
                OpenExternal(RuntimeDownload);
        }
        catch { notice.Text = "浏览器初始化失败，请点击重试"; }
        finally { navigating = false; }
    }

    private void OpenExternal(string address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https") || !string.IsNullOrEmpty(uri.UserInfo)) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch { notice.Text = "无法打开系统浏览器"; }
    }

    private async Task<string?> CallBridge(string expression)
    {
        if (!ready || !Trusted(browser.CoreWebView2.Source)) return null;
        try { return await browser.CoreWebView2.ExecuteScriptAsync($"(() => {{ if (window !== window.top || location.origin !== '{Origin}') return null; return {expression}; }})()"); }
        catch { return null; }
    }

    private async Task<bool> DiscardAllowed(string action)
    {
        if (saving) return false;
        var result = await CallBridge("window.PvAcClient?.canDiscard?.()");
        return result != "false" || MessageBox.Show(this, $"有未保存的内容，确定{action}？", "确认", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) == DialogResult.OK;
    }

    private async Task NavigateGuarded(Action action)
    {
        if (!ready || navigating) return;
        navigating = true;
        try { if (await DiscardAllowed("离开当前页面")) action(); }
        finally { navigating = false; }
    }

    // 固定模块在当前SPA中切换，保留导入数据、登录与回放状态。
    private async Task NavigateModule(string path)
    {
        if (!ready || navigating || saving || path is not ("/" or "/analysis" or "/monitoring")) return;
        if (!Trusted(browser.CoreWebView2.Source)) { await NavigateGuarded(() => browser.CoreWebView2.Navigate(Origin + path)); return; }
        navigating = true;
        try
        {
            var target = JsonSerializer.Serialize(path);
            await browser.CoreWebView2.ExecuteScriptAsync($"(() => {{ if (location.pathname === {target} && !location.search) return; history.pushState({{}}, '', {target}); window.dispatchEvent(new PopStateEvent('popstate')); }})()");
        }
        finally { navigating = false; }
    }

    private async Task Back()
    {
        if (navigating || saving) return;
        navigating = true;
        try
        {
            if (await CallBridge("window.PvAcClient?.back?.()") == "true") return;
            if (ready && browser.CoreWebView2.CanGoBack)
            {
                if (await DiscardAllowed("返回上一页")) browser.CoreWebView2.GoBack();
            }
            else Close();
        }
        finally { navigating = false; }
    }

    private async void SaveMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Trusted(e.Source) || !Trusted(browser.CoreWebView2.Source) || e.Source != browser.CoreWebView2.Source) return;
        string? id = null;
        var source = e.Source;
        var ownsSave = false;
        try
        {
            // 拒绝异常结构；不把输入、文本或令牌写入日志。
            if (e.WebMessageAsJson.Length > 7 * 1024 * 1024) return;
            using var envelope = JsonDocument.Parse(e.WebMessageAsJson);
            // 网页使用 postMessage(JSON.stringify(message))；兼容直接发送对象。
            using var json = envelope.RootElement.ValueKind == JsonValueKind.String
                ? JsonDocument.Parse(envelope.RootElement.GetString()!)
                : JsonDocument.Parse(envelope.RootElement.GetRawText());
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            var type = root.GetProperty("type").GetString();
            if (type is not ("saveText" or "copyText")) return;
            id = root.GetProperty("id").GetString();
            if (string.IsNullOrEmpty(id) || id.Length > 128) return;
            var text = root.GetProperty("text").GetString();
            if (type == "copyText")
            {
                // 网页用户点击调用；只写剪贴板，不请求或读取 ClipboardRead 权限。
                if (text == null || Encoding.UTF8.GetByteCount(text) > 1024 * 1024 || text.Length == 0)
                { await SaveResult(source, id, "failed"); return; }
                Clipboard.SetText(text, TextDataFormat.UnicodeText);
                await SaveResult(source, id, "saved");
                return;
            }
            var name = root.GetProperty("fileName").GetString();
            if (saving || !ValidName(name) || text == null || Encoding.UTF8.GetByteCount(text) > 1024 * 1024)
            { await SaveResult(source, id, "failed"); return; }
            saving = true;
            ownsSave = true;
            using var dialog = new SaveFileDialog { FileName = name, Filter = "文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*", AddExtension = true, DefaultExt = "txt", OverwritePrompt = true, RestoreDirectory = true };
            if (dialog.ShowDialog(this) != DialogResult.OK) { await SaveResult(source, id, "cancelled"); return; }
            await File.WriteAllTextAsync(dialog.FileName, text, new UTF8Encoding(false));
            await SaveResult(source, id, "saved");
        }
        catch { if (id != null) await SaveResult(source, id, "failed"); }
        finally { if (ownsSave) saving = false; }
    }

    private static bool ValidName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 180 || name != Path.GetFileName(name)
            || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.EndsWith('.') || name.EndsWith(' ')) return false;
        var stem = name.Split('.')[0].ToUpperInvariant();
        return stem is not ("CON" or "PRN" or "AUX" or "NUL") && !(stem.Length == 4 && (stem.StartsWith("COM") || stem.StartsWith("LPT")) && stem[3] >= '1' && stem[3] <= '9');
    }

    private async Task SaveResult(string source, string id, string status)
    {
        if (!ready || browser.CoreWebView2.Source != source) return;
        await CallBridge($"window.PvAcClient?.onSaveResult?.({JsonSerializer.Serialize(id)}, {JsonSerializer.Serialize(status)})");
    }
}
