/**
 * routes/ui.js — LightRAG 知识图谱可视化
 */
import http from "node:http";

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

const TYPE_CN = { person:'人物',creature:'生物',organization:'组织',location:'地点',event:'事件',concept:'概念',method:'方法',content:'内容',data:'数据',artifact:'物品',item:'物品',naturalobject:'自然',other:'其他',unknown:'未知',position:'职位',time_period:'时期',ability:'能力',relationship:'关系',law_rule:'规则',PERSON:'人物',ORGANIZATION:'组织',LOCATION:'地点',EVENT:'事件',CONCEPT:'概念',ITEM:'物品',ABILITY:'能力',RELATIONSHIP:'关系',TIME_PERIOD:'时期',LAW_RULE:'规则',UNKNOWN:'未知' };
const COLORS = { person:'#4169E1',creature:'#bd7ebe',organization:'#00cc00',location:'#cf6d17',event:'#00bfa0',concept:'#e3493b',method:'#b71c1c',content:'#0f558a',data:'#0000ff',artifact:'#4421af',item:'#4db6ac',naturalobject:'#b2e061',other:'#f4d371',unknown:'#b0b0b0',position:'#7e57c2',time_period:'#ff7043',ability:'#26a69a',relationship:'#ec407a',law_rule:'#78909c' };
const SKIP = new Set(["PERSON","ORGANIZATION","LOCATION","EVENT","CONCEPT","ITEM","ABILITY","RELATIONSHIP","TIME_PERIOD","LAW_RULE","Other"]);

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LightRAG · Hanako</title>
$HANA_CSS$
<script src="https://unpkg.com/cytoscape@3.30.0/dist/cytoscape.min.js"></script>
<style>
:root{--bg:#0d1117;--text:#c9d1d9;--muted:#8b949e;--accent:#58a6ff;--border:rgba(255,255,255,0.08)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;height:100vh;overflow:hidden}
.bar{display:flex;align-items:center;gap:12px;padding:8px 16px;background:#161b22;border-bottom:1px solid var(--border);flex-shrink:0;font-size:13px}
.bar .t{font-weight:600;color:var(--accent);margin-right:auto}
.bar .s{color:var(--muted)}.bar .s b{color:var(--text)}
.bar button,.bar select{padding:3px 10px;border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:4px;cursor:pointer;font-size:11px}
.bar button:hover,.bar select:hover{border-color:var(--accent);color:var(--accent)}
.bar select option{background:var(--bg);color:var(--text)}
.legend{display:flex;flex-wrap:wrap;gap:2px 0;padding:6px 16px;background:#161b22;border-bottom:1px solid var(--border);flex-shrink:0;font-size:11px;color:var(--muted)}
#cy{flex:1;width:100%;background:var(--bg)}
.empty{display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:8px;color:var(--muted)}
</style>
</head>
<body>
<div class="bar">
  <span class="t">LightRAG · Hanako</span>
  <span class="s">文档 <b id="stat-docs">$DOCS$</b></span>
  <span class="s">实体 <b id="stat-nodes">$NODES$</b></span>
  <span class="s">关系 <b id="stat-edges">$EDGES$</b></span>
  <span id="doc-select">$DOC_SELECT$</span>
  <select id="ws-select" onchange="switchWS(this.value)">$WS_OPTIONS$</select>
  <button onclick="relayout()">重新布局</button>
  <button onclick="if(window.__cy__)window.__cy__.fit(undefined,40)">重置视图</button>
</div>
<div class="legend">$LEGEND$</div>
<div id="cy"></div>
<script>
window.__DATA__={graph:$GRAPH$,COLORS:$COLORS$,TYPES:$TYPES$,workspace:"$WS_KEY$",base:"$BASE$"};
(function init(){
  if(typeof cytoscape==='undefined'){return setTimeout(init,200)}
  window.parent.postMessage({type:'ready'},'*');
  var D=window.__DATA__;
  var cyEl=document.getElementById('cy');
  window.__cy__=null;
  var activeNode=null;

  function hideEdges(){
    if(activeNode){activeNode.removeClass('focus');activeNode=null}
    if(window.__cy__)window.__cy__.edges().removeClass('show').removeClass('labeled');
  }

  function renderGraph(data){
    document.getElementById('ws-select').value=D.workspace||'default';
    if(window.__cy__){window.__cy__.destroy();window.__cy__=null}
    cyEl.innerHTML='';
    if(!data.nodes.length){
      cyEl.innerHTML='<div class=empty><p>暂无知识图谱数据</p><p style=font-size:12px>索引文档后实体和关系会自动出现在这里</p></div>';
      document.getElementById('stat-nodes').textContent='0';
      document.getElementById('stat-edges').textContent='0';
      return;
    }
    var els=[];

    // 计算节点度数 + 对数二次映射到尺寸（拉开顶级枢纽差距）
    var degMap={}; data.nodes.forEach(function(n){degMap[n.id]=0});
    data.edges.forEach(function(e){if(degMap.hasOwnProperty(e.source))degMap[e.source]++;if(degMap.hasOwnProperty(e.target))degMap[e.target]++});
    var maxDeg=1; data.nodes.forEach(function(n){var d=degMap[n.id]||0;if(d>maxDeg)maxDeg=d});
    var logMax=Math.log(maxDeg+1);
    function degToSize(d){if(d<=0)return 6;var r=Math.log(d+1)/logMax;return Math.round(6+24*r*r)}

    data.nodes.forEach(function(n){els.push({data:{id:n.id,label:n.id,color:D.COLORS[n.type]||D.COLORS.other,size:degToSize(degMap[n.id]||0)}})});
    data.edges.forEach(function(e){els.push({data:{id:e.id,source:e.source,target:e.target,label:e.label||''}})});
    var cy=cytoscape({
      container:cyEl,elements:els,
      style:[
        {selector:'node',style:{'background-color':'data(color)',width:'data(size)',height:'data(size)',label:'data(label)',color:'#c9d1d9','font-size':9,'text-valign':'center','text-halign':'center','text-background-opacity':0.5,'text-background-color':'#0d1117','text-background-padding':'2px','border-width':1,'border-color':'#30363d','transition-property':'width,height,border-width','transition-duration':150}},
        {selector:'edge',style:{width:0,'line-color':'#30363d','target-arrow-color':'#30363d','target-arrow-shape':'triangle','arrow-scale':0.7,'curve-style':'bezier',label:'','font-size':8,color:'#8b949e',opacity:0,'transition-property':'opacity,width','transition-duration':200}},
        {selector:'node:selected',style:{'border-color':'#f78166','border-width':3}},
        {selector:'node.focus',style:{'border-color':'#f78166','border-width':3}},
        {selector:'edge.show',style:{opacity:1,width:1.5,'line-color':'#8b949e','target-arrow-color':'#8b949e'}},
        {selector:'edge.show:selected',style:{'line-color':'#f78166','target-arrow-color':'#f78166',width:2.5}},
        {selector:'edge.show.labeled',style:{label:'data(label)'}}
      ],
      layout:{name:'cose',idealEdgeLength:80,nodeOverlap:12,padding:40,nodeRepulsion:function(){return 10000},gravity:0.2,numIter:5000,animate:'end',animationDuration:3000,animationEasing:'ease-in-out',randomize:false,fit:true},
      wheelSensitivity:0.3
    });
    window.__cy__=cy;
    activeNode=null;
    cy.on('tap','node',function(e){
      var n=e.target;
      if(activeNode&&activeNode.id()===n.id()){hideEdges();return}
      hideEdges();activeNode=n;
      n.addClass('focus');n.connectedEdges().addClass('show').addClass('labeled');
    });
    cy.on('tap',function(e){if(e.target===cy)hideEdges()});
    cy.on('mouseover','edge.show',function(e){e.target.addClass('labeled')});
    cy.on('mouseout','edge.show',function(e){if(e.target!==cy.$(':selected')[0])e.target.removeClass('labeled')});
    cy.on('dblclick','node',function(e){cy.animate({center:{eles:e.target},zoom:2.5},{duration:400})});
    cy.on('dblclick',function(e){if(e.target===cy)cy.animate({fit:{eles:cy.elements(),padding:50}},{duration:400})});
    document.getElementById('stat-nodes').textContent=data.nodes.length;
    document.getElementById('stat-edges').textContent=data.edges.length;
  }

  window.relayout=function(){
    if(!window.__cy__)return;hideEdges();
    window.__cy__.layout({name:'cose',idealEdgeLength:80,nodeOverlap:12,padding:40,nodeRepulsion:function(){return 10000},gravity:0.2,numIter:5000,animate:'end',animationDuration:3000,animationEasing:'ease-in-out',randomize:false,fit:true}).run();
  };

  window.switchWS=function(ws){
    D.workspace=ws;
    // 并发获取图谱和文档统计
    var gUrl=D.base+'/graph?workspace='+encodeURIComponent(ws)+'&limit=200';
    var dUrl=D.base+'/documents?workspace='+encodeURIComponent(ws);
    Promise.all([fetch(gUrl).then(function(r){return r.json()}),fetch(dUrl).then(function(r){return r.json()})]).then(function(results){
      var raw=results[0]||{nodes:[],edges:[]};
      var docs=results[1]||{documents:[],total:0};

      // 更新文档统计
      var docList=docs.documents||[];
      var docCount=docs.total||0;
      var processed=docList.filter(function(d){return d.status==='processed'}).length;
      document.getElementById('stat-docs').textContent=docCount;
      var dsEl=document.getElementById('doc-select');
      if(dsEl){
        dsEl.textContent='📄 '+(docCount>0?processed+'/'+docCount+' 已索引':'暂无文档');
        var fpaths=docList.filter(function(d){return d.file_path}).map(function(d){return d.file_path.replace(/^.*[\\/]/,'')}).join(', ');
        dsEl.title=fpaths||'';
      }

      var SKIP2={PERSON:1,ORGANIZATION:1,LOCATION:1,EVENT:1,CONCEPT:1,ITEM:1,ABILITY:1,RELATIONSHIP:1,TIME_PERIOD:1,LAW_RULE:1,Other:1};
      var nodes=raw.nodes.filter(function(n){return !SKIP2[n.id]});
      var nids={};nodes.forEach(function(n){nids[n.id]=1});
      var edges=raw.edges.filter(function(e){return nids[e.source]&&nids[e.target]});
      renderGraph({nodes:nodes.map(function(n){return{id:n.id,type:n.entity_type||'other'}}),edges:edges.map(function(e){return{id:e.id,source:e.source,target:e.target,label:e.label||''}})});

      // 更新图例
      var tc={};nodes.forEach(function(n){var t=n.entity_type||'other';tc[t]=(tc[t]||0)+1});
      var items=Object.entries(tc).sort(function(a,b){return b[1]-a[1]}).slice(0,10);
      var legendEl=document.querySelector('.legend');
      if(legendEl)legendEl.innerHTML=items.map(function(e){var t=e[0],n=e[1],cn=(D.TYPES&&D.TYPES[t])||t.replace(/_/g,' ').replace(/^\w/,function(c){return c.toUpperCase()});return '<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px"><span style="width:10px;height:10px;border-radius:50%;background:'+(D.COLORS[t.toLowerCase()]||D.COLORS.other)+';display:inline-block"></span>'+cn+'</span>'}).join('');
    }).catch(function(e){console.error('switchWS',e)});
  };

  renderGraph(D.graph);
})();
</script>
</body>
</html>`;

function esc(v) { return String(v).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

export default function registerRoutes(app, ctx) {
  app.get("/page", async (c) => {
    const port = (await ctx.config.get("lightragPort")) || 9621;
    const base = `http://127.0.0.1:${port}`;
    const hanaCss = c.req.query("hana-css") || "";
    const ws = c.req.query("workspace") || "default";

    const workspaces = (await ctx.config.get("workspaces")) || {"default":"默认知识库"};
    const wsOptions = Object.entries(workspaces)
      .map(([k,v]) => `<option value="${esc(k)}" ${k===ws?'selected':''}>${esc(String(v))}</option>`).join("");

    let graph = null, docs = null;
    try { graph = await fetchJSON(`${base}/graph?workspace=${encodeURIComponent(ws)}&limit=200`); } catch (e) {}
    try { docs = await fetchJSON(`${base}/documents?workspace=${encodeURIComponent(ws)}`); } catch (e) {}
    const RAW = graph || { nodes: [], edges: [] };
    const docList = docs?.documents || [];
    const docCount = docs?.total || 0;
    const processedCount = docList.filter(d => d.status === "processed").length;

    // 文档统计（纯展示，不可点击）
    const docSelect = docList.length > 0
      ? `<span class="s" style="font-size:10px;cursor:default" title="${esc(docList.filter(d=>d.file_path).map(d=>d.file_path.replace(/^.*[\\/]/, '')).join(', '))}">📄 ${processedCount}/${docCount} 已索引</span>`
      : `<span class="s" style="font-size:10px">📄 暂无文档</span>`;

    const nodes = RAW.nodes.filter(n => !SKIP.has(n.id));
    const nids = new Set(nodes.map(n => n.id));
    const edges = RAW.edges.filter(e => nids.has(e.source) && nids.has(e.target));

    const typeCount = {};
    nodes.forEach(n => { const t = n.entity_type || "other"; typeCount[t] = (typeCount[t]||0)+1; });

    return c.html(HTML
      .replace("$HANA_CSS$", hanaCss ? `<link rel="stylesheet" href="${esc(hanaCss)}">` : "")
      .replace(/\$DOCS\$/g, String(docCount))
      .replace("$DOC_SELECT$", docSelect)
      .replace(/\$NODES\$/g, String(nodes.length))
      .replace(/\$EDGES\$/g, String(edges.length))
      .replace("$WS_OPTIONS$", wsOptions)
      .replace("$WS_KEY$", esc(ws))
      .replace("$BASE$", base)
      .replace("$LEGEND$", Object.entries(typeCount).sort((a,b)=>b[1]-a[1]).slice(0,10)
        .map(([t,n]) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px"><span style="width:10px;height:10px;border-radius:50%;background:${COLORS[t.toLowerCase()]||COLORS.other};display:inline-block"></span>${TYPE_CN[t] || t.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase())}</span>`).join(""))
      .replace("$GRAPH$", JSON.stringify({
        nodes: nodes.map(n => ({ id:n.id, type:n.entity_type||"other" })),
        edges: edges.map(e => ({ id:e.id, source:e.source, target:e.target, label:e.label||"" }))
      }))
      .replace("$COLORS$", JSON.stringify(COLORS))
      .replace("$TYPES$", JSON.stringify(TYPE_CN))
    );
  });
}
