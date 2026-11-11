const { chromium } = require('C:/Users/sun/.agents/skills/web-analysis-ai/node_modules/playwright');
(async()=>{
  for (const [port,url,name] of [[9222,'https://maimai.cn/community/home/gossip','脉脉'],[9223,'https://www.xiaohongshu.com/search_result?keyword=%E5%A4%A7%E7%96%86','小红书']]) {
    try {
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const ctx = b.contexts()[0];
      const p = await ctx.newPage();
      await p.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
      await p.waitForTimeout(5000);
      const r = await p.evaluate(()=>({url:location.href.slice(0,70), loginWall:/登录后查看|platform\/login/.test(location.href+document.body.innerText), len:document.body.innerText.length}));
      console.log(name, JSON.stringify(r));
      await p.close(); await b.close();
    } catch(e){ console.log(name,'ERR',e.message.slice(0,80)); }
  }
})();
