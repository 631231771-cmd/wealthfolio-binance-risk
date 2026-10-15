// Windows/.NET Framework 自带库；不依赖服务，不向宿主交付认证信息。
using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Security.Cryptography;
using System.Collections.Generic;
using System.Collections;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Threading;
using System.Threading.Tasks;
[assembly: System.Reflection.AssemblyVersion("0.1.8.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.1.8.0")]

internal sealed class SafeFailure : Exception {
    internal readonly string Code;
    internal SafeFailure(string code) : base(code) { Code=code; }
}
internal static class Data {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=1000000 };
    internal static string Utc() { return DateTime.UtcNow.ToString("o"); }
    internal static string String(Dictionary<string,object> d,string key) {
        object value; if(!d.TryGetValue(key,out value)||!(value is string))throw new SafeFailure("INVALID");return (string)value;
    }
    internal static bool Nonzero(string value) {
        if(value.Length>80||!Regex.IsMatch(value,@"^\d+(\.\d+)?$"))throw new SafeFailure("INVALID");
        return Regex.IsMatch(value,"[1-9]"); // 只判定精确零，不用double/decimal舍入掉极小余额。
    }
    internal static string Uid(object v) {
        string value=Convert.ToString(v,CultureInfo.InvariantCulture);
        if(!Regex.IsMatch(value??"",@"^\d{1,20}$"))throw new SafeFailure("IDENTITY");return value;
    }
}
internal sealed class Pair {
    public string Key {get;set;} public string Secret {get;set;} public string Uid {get;set;}
}
internal sealed class Vault {
    private readonly string path;
    internal Vault(string directory) { Directory.CreateDirectory(directory); path=Path.Combine(directory,"credentials.dpapi"); }
    internal Pair Read() {
        if(!File.Exists(path))return null;
        byte[] plain=null;
        try { plain=ProtectedData.Unprotect(File.ReadAllBytes(path),null,DataProtectionScope.CurrentUser); var p=Data.Json.Deserialize<Pair>(Encoding.UTF8.GetString(plain));Validate(p);return p; }
        catch {throw new SafeFailure("VAULT_READ");}
        finally {if(plain!=null)Array.Clear(plain,0,plain.Length);}
    }
    internal static void Validate(Pair p) {
        if(p==null||String.IsNullOrWhiteSpace(p.Key)||String.IsNullOrWhiteSpace(p.Secret)||p.Key.Length>512||p.Secret.Length>512||p.Key.Trim()!=p.Key||p.Secret.Trim()!=p.Secret)throw new SafeFailure("CREDENTIAL");Data.Uid(p.Uid);
    }
    internal void Save(Pair p,bool injectFailure=false) {
        Validate(p);byte[] plain=Encoding.UTF8.GetBytes(Data.Json.Serialize(p));string candidate=path+".candidate";
        try {
            File.WriteAllBytes(candidate,ProtectedData.Protect(plain,null,DataProtectionScope.CurrentUser));
            byte[] check=ProtectedData.Unprotect(File.ReadAllBytes(candidate),null,DataProtectionScope.CurrentUser);
            try {if(!CryptographicEquals(plain,check))throw new SafeFailure("VAULT_VERIFY");}finally{Array.Clear(check,0,check.Length);}
            if(injectFailure)throw new SafeFailure("VAULT_SAVE");
            // 同卷原子替换；候选核验失败时旧文件未动。不创建旧密钥备份。
            if(File.Exists(path))File.Replace(candidate,path,null);else File.Move(candidate,path);
        }catch{throw new SafeFailure("VAULT_SAVE");}
        finally{Array.Clear(plain,0,plain.Length);if(File.Exists(candidate))File.Delete(candidate);}
    }
    private static bool CryptographicEquals(byte[] a,byte[] b){if(a.Length!=b.Length)return false;int n=0;for(int i=0;i<a.Length;i++)n|=a[i]^b[i];return n==0;}
    internal void Delete(){try{if(File.Exists(path))File.Delete(path);if(File.Exists(path+".candidate"))File.Delete(path+".candidate");if(Read()!=null)throw new SafeFailure("VAULT_DELETE");}catch{throw new SafeFailure("VAULT_DELETE");}}
}
internal sealed class Reader : IDisposable {
    private readonly HttpClient client;
    private readonly bool live;
    private readonly string origin;
    private readonly int timeoutMs;
    private DateTime cooldownUntil=DateTime.MinValue;
    private CancellationTokenSource cancellation=new CancellationTokenSource();
    internal Reader(bool real) : this(real,"https://api.binance.com",new HttpClientHandler {AllowAutoRedirect=false}) {}
    // 仅自检代码能提供测试传输；运行界面没有URL、header、路径或代理配置输入。
    internal Reader(bool real,string testOrigin,HttpMessageHandler handler,int timeout=10000) {
        live=real;origin=testOrigin;timeoutMs=timeout;client=new HttpClient(handler);client.Timeout=TimeSpan.FromMilliseconds(timeout);
        if(real && origin!="https://api.binance.com")throw new SafeFailure("ORIGIN");
    }
    internal void Disconnect(){cancellation.Cancel();}
    private async Task<Dictionary<string,object>> Send(string path,string query,Pair pair,CancellationToken token) {
        if(path!="/api/v3/time"&&path!="/api/v3/account")throw new SafeFailure("PATH");
        try {
            using(var req=new HttpRequestMessage(HttpMethod.Get,origin+path+query)) {
                if(pair!=null)req.Headers.Add("X-MBX-APIKEY",pair.Key);
                using(var response=await client.SendAsync(req,HttpCompletionOption.ResponseHeadersRead,token)) {
                    int status=(int)response.StatusCode;
                    if(status==429||status==418){var retry=response.Headers.RetryAfter;double seconds=retry!=null&&retry.Delta.HasValue?retry.Delta.Value.TotalSeconds:60;cooldownUntil=DateTime.UtcNow.AddSeconds(seconds>0&&seconds<=86400?seconds:60);throw new SafeFailure("RATE_LIMIT");}
                    if(status==401||status==403)throw new SafeFailure("AUTH");
                    if(status!=200)throw new SafeFailure("HTTP");
                    using(var stream=await response.Content.ReadAsStreamAsync())using(var abort=token.Register(()=>stream.Dispose()))using(var memory=new MemoryStream()) {
                        byte[] buffer=new byte[4096];int count;
                        while((count=await stream.ReadAsync(buffer,0,buffer.Length,token))>0){if(memory.Length+count>1000000)throw new SafeFailure("SIZE");memory.Write(buffer,0,count);}
                        var body=Data.Json.DeserializeObject(Encoding.UTF8.GetString(memory.ToArray())) as Dictionary<string,object>;
                        if(body==null)throw new SafeFailure("INVALID");return body;
                    }
                }
            }
        }catch(SafeFailure){throw;}
        catch(OperationCanceledException){throw new SafeFailure("TIMEOUT_OR_DISCONNECTED");}
        catch{throw new SafeFailure(token.IsCancellationRequested?"TIMEOUT_OR_DISCONNECTED":"NETWORK_OR_INVALID");} // 不传递原异常、cause、URL或header。
    }
    internal async Task<string> Read(Pair pair) {
        Vault.Validate(pair);
        if(live&&(pair.Key.StartsWith("WRISK_")||pair.Secret.StartsWith("WRISK_")))throw new SafeFailure("FIXTURE_CREDENTIAL_NOT_LIVE");
        if(DateTime.UtcNow<cooldownUntil)throw new SafeFailure("RATE_LIMIT");
        using(var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token)) {
        deadline.CancelAfter(timeoutMs+5000);CancellationToken token=deadline.Token;if(token.IsCancellationRequested)throw new SafeFailure("DISCONNECTED");
        if(!live && origin=="https://api.binance.com")return Fixture(pair.Uid); // 默认界面绝无认证网络。
        try {
            DateTime start=DateTime.UtcNow;
            var time=await Send("/api/v3/time","",null,token);DateTime received=DateTime.UtcNow;
            long server=Convert.ToInt64(time["serverTime"],CultureInfo.InvariantCulture);
            long local=(long)(start.AddTicks((received-start).Ticks/2)-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
            if((received-start).TotalSeconds>2||Math.Abs(server-local)>60000)throw new SafeFailure("CLOCK");
            long stamp=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds+(server-local);
            string payload="timestamp="+stamp.ToString(CultureInfo.InvariantCulture)+"&recvWindow=5000";
            string signature;
            using(var mac=new HMACSHA256(Encoding.UTF8.GetBytes(pair.Secret)))signature=BitConverter.ToString(mac.ComputeHash(Encoding.UTF8.GetBytes(payload))).Replace("-","").ToLowerInvariant();
            string began=Data.Utc();var result=await Send("/api/v3/account","?"+payload+"&signature="+signature,pair,token);string ended=Data.Utc();token.ThrowIfCancellationRequested();
            if(Data.Uid(result["uid"])!=pair.Uid||Data.String(result,"accountType")!="SPOT")throw new SafeFailure("IDENTITY");
            var rows=result["balances"] as object[];if(rows==null||rows.Length>10000)throw new SafeFailure("INVALID");
            var balances=new List<object>();var seen=new HashSet<string>();
            foreach(var value in rows){var row=value as Dictionary<string,object>;if(row==null)throw new SafeFailure("INVALID");string asset=Data.String(row,"asset"),free=Data.String(row,"free"),locked=Data.String(row,"locked");if(!Regex.IsMatch(asset,"^[A-Z0-9]{1,40}$")||asset.StartsWith("WRISKDEMO")||!seen.Add(asset))throw new SafeFailure("INVALID");bool hasFree=Data.Nonzero(free),hasLocked=Data.Nonzero(locked);if(hasFree||hasLocked)balances.Add(new {asset,free,locked});}
            return Envelope(live?"external":"fixture",pair.Uid,"ready",began,ended,balances.ToArray());
        }catch(SafeFailure){throw;}catch{throw new SafeFailure("INVALID_OR_DISCONNECTED");}
        }
    }
    internal static string Envelope(string mode,string uid,string status,string start,string end,object[] balances){return Data.Json.Serialize(new {format="wrisk-spot-snapshot",version=1,mode,uid,status,startedAt=start,endedAt=end,balances});}
    internal static string Fixture(string uid){string at=Data.Utc();return Envelope("fixture",uid,"ready",at,at,new object[]{new{asset="BTC",free="0.001",locked="0"},new{asset="ETH",free="0.02",locked="0"},new{asset="USDT",free="12",locked="3"},new{asset="NOPAIR",free="2",locked="0"}});}
    public void Dispose(){Disconnect();client.Dispose();cancellation.Dispose();}
}
internal sealed class MainForm : Form {
    private readonly bool live;
    private readonly Vault vault;
    private Reader reader;
    private readonly TextBox key=new TextBox {UseSystemPasswordChar=true,Width=470},secret=new TextBox {UseSystemPasswordChar=true,Width=470},uid=new TextBox {Width=180};
    private readonly TextBox output=new TextBox {Multiline=true,ReadOnly=true,Width=640,Height=170,ScrollBars=ScrollBars.Vertical};
    private readonly Label status=new Label {AutoSize=true,MaximumSize=new System.Drawing.Size(640,0)};
    private readonly Button read=new Button {Text="读取并生成余额快照",AutoSize=true};
    private readonly CheckBox consent=new CheckBox {Text="我已获准，只读取这个小额测试账户（真实请求）",AutoSize=true};
    private bool busy=false,disconnected=false;
    internal MainForm(bool real) {
        live=real;Text="WRISK 本地 Spot 只读读取器 0.1.8";Width=710;Height=660;
        string directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"WealthfolioBinanceRisk",live?"spot-live":"spot-fixture");vault=new Vault(directory);reader=new Reader(live);
        var panel=new FlowLayoutPanel {Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(12)};Controls.Add(panel);
        panel.Controls.Add(new Label {AutoSize=true,MaximumSize=new System.Drawing.Size(640,0),Text=live?"真实模式：仅固定官方 GET time/account；不会下单。UID必须是独立小额测试账户。":"虚构验收模式：不发送认证请求；不能输入真实密钥。真实模式需下一阶段单独授权。"});
        panel.Controls.Add(new Label{Text="预期 Binance UID（与账户核对）",AutoSize=true});panel.Controls.Add(uid);uid.Text=live?"":"900000001";
        panel.Controls.Add(new Label{Text="API Key（仅本机加密保存）",AutoSize=true});panel.Controls.Add(key);
        panel.Controls.Add(new Label{Text="Secret",AutoSize=true});panel.Controls.Add(secret);
        var save=new Button{Text="安全保存／替换凭据",AutoSize=true};panel.Controls.Add(save);
        save.Click+=(s,e)=>{if(busy)return;try{vault.Save(new Pair{Key=key.Text,Secret=secret.Text,Uid=uid.Text});status.Text="凭据已加密保存并核验；未发送请求。";}catch{status.Text="保存失败；旧凭据保持。";}finally{key.Clear();secret.Clear();}};
        panel.Controls.Add(consent);consent.Visible=live;consent.Checked=false;panel.Controls.Add(read);
        read.Click+=async(s,e)=>{
            if(busy||disconnected)return;if(live&&!consent.Checked){status.Text="尚未确认真实只读请求。";return;}
            busy=true;read.Enabled=false;output.Clear();Pair pair=null;
            try{pair=vault.Read();if(pair==null)throw new SafeFailure("NO_CREDENTIAL");if(pair.Uid!=uid.Text)throw new SafeFailure("IDENTITY");output.Text=await reader.Read(pair);status.Text=live?"真实余额已获取；请主动导入插件，60秒内有效。":"虚构余额快照已生成；来源fixture，数量不是真实资产。";}
            catch(SafeFailure failure){status.Text="读取不可用："+failure.Code+"；不得将失败当作零资产。";if(pair!=null)output.Text=Reader.Envelope(live?"external":"fixture",pair.Uid,"failed",Data.Utc(),Data.Utc(),new object[0]);}
            catch{status.Text="读取不可用：INTERNAL；无原始异常输出。";}
            finally{busy=false;read.Enabled=!disconnected;pair=null;}
        };
        var disconnect=new Button{Text="断开（停止新请求）",AutoSize=true};panel.Controls.Add(disconnect);disconnect.Click+=(s,e)=>{disconnected=true;reader.Disconnect();read.Enabled=false;output.Clear();status.Text="已断开；不再接受当前会话结果，重新打开程序才可读取。";};
        var remove=new Button{Text="断开并删除本机凭据",AutoSize=true};panel.Controls.Add(remove);remove.Click+=(s,e)=>{if(busy)return;if(MessageBox.Show("仅删除本读取器当前模式的本机凭据；不撤销币安端密钥。确认？","清理凭据",MessageBoxButtons.YesNo)!=DialogResult.Yes)return;try{disconnected=true;reader.Disconnect();read.Enabled=false;vault.Delete();key.Clear();secret.Clear();output.Clear();status.Text="本机凭据已删除，读回为空；不等于币安端撤销。";}catch{status.Text="删除未确认完成；保持断开，请重试。";}};
        panel.Controls.Add(status);panel.Controls.Add(new Label{Text="余额快照（不含凭据；仍属于资产隐私），Ctrl+A / Ctrl+C后在插件独立入口粘贴。失败快照也必须导入，避免误用历史余额。",AutoSize=true,MaximumSize=new System.Drawing.Size(640,0)});panel.Controls.Add(output);
        try{Pair p=vault.Read();status.Text=p==null?"本机没有已保存凭据。":"本机已有凭据，已成功读回；没有自动请求。";if(p!=null)uid.Text=p.Uid;}catch{status.Text="凭据状态未知，保持断开。";disconnected=true;read.Enabled=false;}
        FormClosed+=(s,e)=>reader.Dispose();
    }
}
internal static class Program {
    [STAThread] private static int Main(string[] args){
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        if(args.Length==2 && args[0]=="--self-test")return SelfTest.Run(args[1]);
        if(args.Length==2 && args[0]=="--self-test-child")return SelfTest.Child(args[1]);
        if(args.Length>1 || args.Length==1 && args[0]!="--allow-live")return 2;
        Application.EnableVisualStyles();Application.Run(new MainForm(args.Length==1));return 0;
    }
}
