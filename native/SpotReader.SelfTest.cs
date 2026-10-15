using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Threading;

internal sealed class FaultHandler : HttpMessageHandler {
    internal bool Signed;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken c){
        if(r.RequestUri.AbsolutePath.EndsWith("/time"))return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(Data.Json.Serialize(new{serverTime=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds}))});
        Signed=r.RequestUri.Query.Contains("signature=");throw new HttpRequestException("WRISK_FAKE_SECRET_B "+r.RequestUri);
    }
}
internal sealed class TestServer : IDisposable {
    private readonly TcpListener listener=new TcpListener(IPAddress.Loopback,0);
    internal readonly string Origin;
    internal string Mode="ready";
    internal int Count,Accounts;
    internal bool Valid=true;
    internal TestServer(){listener.Start();Origin="http://127.0.0.1:"+((IPEndPoint)listener.LocalEndpoint).Port;Task.Run(()=>Loop());}
    private async Task Loop(){
        while(true){TcpClient socket;try{socket=await listener.AcceptTcpClientAsync();}catch{return;}
            using(socket){try{var stream=socket.GetStream();var input=new StreamReader(stream,Encoding.ASCII);string line=await input.ReadLineAsync();Count++;var headers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);string h;while(!String.IsNullOrEmpty(h=await input.ReadLineAsync())){int at=h.IndexOf(':');headers[h.Substring(0,at)]=h.Substring(at+1).Trim();}
                bool account=line.StartsWith("GET /api/v3/account?");bool time=line=="GET /api/v3/time HTTP/1.1";Valid&=account||time;
                if(account){Accounts++;string path=line.Split(' ')[1];int mark=path.IndexOf("&signature=");string payload=path.Substring(path.IndexOf('?')+1,mark-path.IndexOf('?')-1);string expected;using(var mac=new HMACSHA256(Encoding.UTF8.GetBytes("WRISK_FAKE_SECRET_B")))expected=BitConverter.ToString(mac.ComputeHash(Encoding.UTF8.GetBytes(payload))).Replace("-","").ToLowerInvariant();Valid&=path.Substring(mark+11)==expected&&headers["X-MBX-APIKEY"]=="WRISK_FAKE_KEY_B";}
                string body;int code=200;
                if(account && Mode=="drop")continue;
                if(account && Mode=="hang"){byte[] partial=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n");await stream.WriteAsync(partial,0,partial.Length);await Task.Delay(6500);continue;}
                if(Mode=="ready" || time)body=time?Data.Json.Serialize(new{serverTime=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds}):Data.Json.Serialize(new{uid=900000001L,accountType="SPOT",extra="WRISK_FAKE_SECRET_B",balances=new object[]{new{asset="BTC",free="0.001",locked="0"},new{asset="ETH",free="0.02",locked="0"},new{asset="USDT",free="12",locked="3"},new{asset="NOPAIR",free="2",locked="0"}}});
                else{code=Int32.Parse(Mode);body="WRISK_FAKE_KEY_B WRISK_FAKE_SECRET_B signature=FAKE";}
                byte[] bytes=Encoding.UTF8.GetBytes(body);byte[] head=Encoding.ASCII.GetBytes("HTTP/1.1 "+code+" Test\r\nContent-Type: application/json\r\nContent-Length: "+bytes.Length+"\r\nRetry-After: 1\r\nConnection: close\r\n\r\n");await stream.WriteAsync(head,0,head.Length);await stream.WriteAsync(bytes,0,bytes.Length);
            }catch{Valid=false;}}
        }
    }
    public void Dispose(){listener.Stop();}
}
internal static class SelfTest {
    private static Pair A(){return new Pair{Key="WRISK_FAKE_KEY_A",Secret="WRISK_FAKE_SECRET_A",Uid="900000001"};}
    private static Pair B(){return new Pair{Key="WRISK_FAKE_KEY_B",Secret="WRISK_FAKE_SECRET_B",Uid="900000001"};}
    private static void Check(bool ok){if(!ok)throw new Exception("SELF_TEST_FAILED");}
    internal static int Child(string directory){try{if(!Path.GetFullPath(directory).StartsWith(Path.Combine(Path.GetTempPath(),"WRISK-SpotReader-"),StringComparison.OrdinalIgnoreCase))return 2;return new Vault(directory).Read().Key==A().Key?0:1;}catch{return 1;}}
    internal static int Run(string reportPath){
        string dir=Path.Combine(Path.GetTempPath(),"WRISK-SpotReader-"+Guid.NewGuid().ToString("N"));
        var passed=new List<string>();
        try {
            Check(Data.Nonzero("0.000000000000000000000000000000000001")&&!Data.Nonzero("000.000"));passed.Add("极小余额不因浮点/decimal舍入被丢弃");
            var vault=new Vault(dir);Check(vault.Read()==null);vault.Save(A());Check(vault.Read().Secret==A().Secret);
            byte[] encrypted=File.ReadAllBytes(Path.Combine(dir,"credentials.dpapi"));Check(!Encoding.UTF8.GetString(encrypted).Contains(A().Secret));passed.Add("DPAPI保存/读回/密文无明文");
            var start=new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,"--self-test-child \""+dir+"\""){UseShellExecute=false,CreateNoWindow=true};using(var child=Process.Start(start)){Check(child.WaitForExit(10000)&&child.ExitCode==0);}passed.Add("独立进程重启读回");
            try{vault.Save(B(),true);throw new Exception();}catch(SafeFailure){}Check(vault.Read().Key==A().Key);vault.Save(B());Check(vault.Read().Secret==B().Secret);passed.Add("替换失败保留旧值/成功替换");
            using(var server=new TestServer()) {
                using(var reader=new Reader(false,server.Origin,new HttpClientHandler{AllowAutoRedirect=false,UseProxy=false})){
                    string snapshot=reader.Read(B()).GetAwaiter().GetResult();Check(snapshot.Contains("fixture")&&!snapshot.Contains(B().Secret)&&!snapshot.Contains(B().Key)&&!snapshot.Contains("signature")&&!snapshot.Contains("extra"));File.WriteAllText(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(reportPath)),"spot-reader-fixture.json"),snapshot);Check(server.Valid&&server.Accounts==1);passed.Add("真实loopback HTTP/签名/header校验/白名单快照");
                    foreach(string code in new[]{"503","401","403","302"}){server.Mode=code;try{reader.Read(B()).GetAwaiter().GetResult();throw new Exception();}catch(SafeFailure e){Check(!e.Message.Contains("signature")&&!e.Message.Contains("WRISK_"));}}
                    passed.Add("HTTP失败/认证拒绝/重定向不跟随/错误无敏感内容");
                    server.Mode="drop";try{reader.Read(B()).GetAwaiter().GetResult();throw new Exception();}catch(SafeFailure e){Check(e.Code=="NETWORK_OR_INVALID");}passed.Add("原生签名HTTP连接被中断只输出固定错误");
                }
                foreach(string code in new[]{"429","418"})using(var reader=new Reader(false,server.Origin,new HttpClientHandler{UseProxy=false,AllowAutoRedirect=false})){server.Mode=code;try{reader.Read(B()).GetAwaiter().GetResult();}catch(SafeFailure){}int count=server.Count;try{reader.Read(B()).GetAwaiter().GetResult();}catch(SafeFailure e){Check(e.Code=="RATE_LIMIT");}Check(server.Count==count);}passed.Add("429/418冷却且不自动重试");
                server.Mode="hang";using(var reader=new Reader(false,server.Origin,new HttpClientHandler{UseProxy=false,AllowAutoRedirect=false},100)){var watch=Stopwatch.StartNew();try{reader.Read(B()).GetAwaiter().GetResult();throw new Exception();}catch(SafeFailure e){Check(e.Code=="TIMEOUT_OR_DISCONNECTED"&&watch.ElapsedMilliseconds<6500);}}passed.Add("原生签名响应body停滞由总时限取消，错误无URL");
            }
            var fault=new FaultHandler();using(var reader=new Reader(false,"http://127.0.0.1:1",fault)){try{reader.Read(B()).GetAwaiter().GetResult();throw new Exception();}catch(SafeFailure e){Check(e.Code=="NETWORK_OR_INVALID"&&fault.Signed);}}passed.Add("含完整签名URL/假Secret的传输异常不外泄");
            using(var reader=new Reader(false)){reader.Disconnect();try{reader.Read(B()).GetAwaiter().GetResult();throw new Exception();}catch(SafeFailure e){Check(e.Code=="DISCONNECTED");}}passed.Add("断开拒绝新请求");
            using(var reader=new Reader(false,"https://127.0.0.1:1",new HttpClientHandler{UseProxy=false,AllowAutoRedirect=false},100)){try{reader.Read(B()).GetAwaiter().GetResult();throw new Exception();}catch(SafeFailure e){Check(!e.Message.Contains("127.0.0.1"));}}passed.Add("原生连接失败只返回固定错误");
            vault.Delete();Check(vault.Read()==null);passed.Add("删除读回null");
            File.WriteAllText(reportPath,Data.Json.Serialize(new{success=true,passed,privateBinanceRequest=false}));return 0;
        }catch{File.WriteAllText(reportPath,Data.Json.Serialize(new{success=false,passed,error="SELF_TEST_FAILED"}));return 1;}
        finally{if(Directory.Exists(dir)){foreach(string name in new[]{"credentials.dpapi","credentials.dpapi.candidate"}){string p=Path.Combine(dir,name);if(File.Exists(p))File.Delete(p);}Directory.Delete(dir);}}
    }
}
