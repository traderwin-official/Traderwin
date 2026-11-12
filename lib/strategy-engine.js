const ok=n=>Number.isFinite(n);
export function ema(v,p){if(!Array.isArray(v)||v.length<p||p<2||!v.every(ok))throw new RangeError("Invalid EMA input.");let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p,a=2/(p+1);for(let i=p;i<v.length;i++)x=v[i]*a+x*(1-a);return x;}
export function rsi(v,p=14){if(!Array.isArray(v)||v.length<=p||!v.every(ok))throw new RangeError("Invalid RSI input.");let g=0,l=0;for(let i=1;i<=p;i++){let d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}g/=p;l/=p;for(let i=p+1;i<v.length;i++){let d=v[i]-v[i-1];g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p;}return l===0?100:100-100/(1+g/l);}
export function atr(c,p=14){if(!Array.isArray(c)||c.length<=p)throw new RangeError("Invalid ATR input.");let t=c.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-c[i].close),Math.abs(x.low-c[i].close)));if(!t.every(x=>ok(x)&&x>=0))throw new RangeError("Invalid candle ranges.");let a=t.slice(0,p).reduce((x,y)=>x+y,0)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a;}
export function analyseCandles(c){
 if(!Array.isArray(c)||c.length<35)throw new RangeError("At least 35 completed candles are required.");
 for(const x of c)if(!x||![x.open,x.high,x.low,x.close].every(ok)||x.low<=0||x.high<x.low||x.open<x.low||x.open>x.high||x.close<x.low||x.close>x.high)throw new RangeError("Invalid OHLC candle.");
 const closes=c.map(x=>x.close),last=closes.at(-1),e9=ema(closes,9),e21=ema(closes,21),momentum=rsi(closes),vol=atr(c),prior=c.slice(-21,-1),hi=Math.max(...prior.map(x=>x.high)),lo=Math.min(...prior.map(x=>x.low));
 const trend=e9>e21?1:e9<e21?-1:0,mom=momentum>=55?1:momentum<=45?-1:0,breakout=last>hi?1:last<lo?-1:0,position=last>e9?1:last<e9?-1:0;
 let score=trend*30+mom*20+breakout*30+position*10;const volRatio=vol/last;if(volRatio>.03)score*=.5;
 const direction=score>=60?"BUY":score<=-60?"SELL":"WAIT";
 return {direction,confidence:Math.min(95,Math.round(Math.abs(score))),strategy:"MULTI_CONFIRMATION_V1",score,indicators:{ema9:e9,ema21:e21,rsi14:momentum,atr14:vol,atrRatio:volRatio,prior20High:hi,prior20Low:lo},explanation:direction==="WAIT"?"Confirmations are mixed or insufficient.":"Directional confirmations aligned; check spread, session, news and contract specifications before any order."};
}