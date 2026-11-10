import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {parseLink,ParseError,extractLink} from './lib/xhs.mjs';
import {verifyTicket} from './lib/parse-ticket.mjs';
const key=process.env.PARSER_KEY;
if(!key||key.length<32)throw new Error('PARSER_KEY must be configured with at least 32 random characters.');
const expected=Buffer.from('Bearer '+key);
let active=0;
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status,data)=>{res.writeHead(status);res.end(JSON.stringify(data));};
  const allowedOrigin=req.headers.origin==='https://xiaohong-jingtu-1029.mnnn79223.chatgpt.site';
  res.setHeader('Vary','Origin');
  if(allowedOrigin)res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
  if(req.method==='OPTIONS'&&req.url==='/parse'){
    if(!allowedOrigin)return send(403,{error:'Origin not allowed'});
    res.setHeader('Access-Control-Allow-Methods','POST');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age','600');
    res.writeHead(204);return res.end();
  }
  if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true});
  const provided=Buffer.from(req.headers.authorization||'');
  const master=provided.length===expected.length&&timingSafeEqual(provided,expected);
  if(!master&&!allowedOrigin)return send(401,{error:'Unauthorized'});
  if(req.method!=='POST'||req.url!=='/parse')return send(404,{error:'Not found'});
  if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
  let counted=false;
  try{
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>15000)return send(413,{error:'分享内容过长。'});chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(400,{error:'无效请求。'});}
    const link=extractLink(body?.url);
    if(!master&&!await verifyTicket((req.headers.authorization||'').replace(/^Bearer /,''),link,key))return send(401,{error:'解析凭证已失效，请重新点击解析。',code:'INVALID_TICKET'});
    if(active>=2)return send(429,{error:'解析服务繁忙，请稍后重试。'});
    active++;counted=true;
    send(200,await parseLink(link));
  }catch(e){send(e instanceof ParseError?503:422,{error:e instanceof Error?e.message:'解析失败',code:e instanceof ParseError?e.code:'PARSE_FAILED'});}
  finally{if(counted)active--;}
});
server.requestTimeout=30000;
server.headersTimeout=10000;
server.listen(Number(process.env.PORT||10000),process.env.HOST||'0.0.0.0',()=>console.log('Parser service ready'));
