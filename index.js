const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

const config = {
    DATA_FILE: process.env.DATA_FILE || 'data.json',
};

const logger = {
    info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
    error: (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, err?.message || '')
};

app.use(compression());
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:", "http:"],
            mediaSrc: ["'self'", "blob:", "data:", "https:", "http:"],
            connectSrc: ["'self'", "https:", "http:"]
        }
    }
}));

const videoProxyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { status: 'error', message: 'Demasiadas solicitudes' }
});

let MOVIES_LIST = [];
let DATA_LOADED = false;

function loadData() {
    try {
        const jsonPath = path.join(__dirname, config.DATA_FILE);
        if (!fs.existsSync(jsonPath)) {
            console.error('❌ NO EXISTE data.json');
            return;
        }
        const raw = fs.readFileSync(jsonPath, 'utf8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) throw new Error('data.json debe ser un array');

        // Mantener orden original del JSON
        MOVIES_LIST = data.map((item, index) => ({
            id: index,
            title: item.title || 'Sin título',
            poster: item.logo || '',
            url: item.url || ''
        }));

        DATA_LOADED = true;
        logger.info(`${MOVIES_LIST.length} películas cargadas`);
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

loadData();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/api/stats', (req, res) => {
    res.json({ status: 'ok', movies: MOVIES_LIST.length, loaded: DATA_LOADED });
});

app.get('/api/movies', (req, res) => {
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 550;
    const search = (req.query.q || '').toLowerCase();

    let list = [...MOVIES_LIST];
    if (search) list = list.filter(m => m.title.toLowerCase().includes(search));

    const total = list.length;
    const start = page * limit;
    res.json({ status: 'ok', total, page, hasMore: start + limit < total, data: list.slice(start, start + limit) });
});

app.get('/video-proxy', videoProxyLimiter, (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).end();
    try {
        const parsed = new URL(decodeURIComponent(url));
        const client = parsed.protocol === 'https:' ? https : http;
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' }
        };
        if (req.headers.range) opts.headers['Range'] = req.headers.range;

        const proxyReq = client.request(opts, (proxyRes) => {
            if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                return res.redirect('/video-proxy?url=' + encodeURIComponent(proxyRes.headers.location));
            }
            res.status(proxyRes.statusCode);
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
            if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
            if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', () => res.status(502).end());
        proxyReq.end();
    } catch (e) {
        res.status(400).end();
    }
});

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <meta name="theme-color" content="#0a0a0a">
    <title>Movies+</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;user-select:none}
        :root{--primary:#f5c518;--bg:#0a0a0a;--surface:#141414;--text:#fff;--text2:#888;--border:#222}
        html,body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
        #app{min-height:100vh;display:flex;flex-direction:column}
        .header{padding:10px 12px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:100}
        .logo{font-size:18px;font-weight:800;color:var(--primary)}
        #search{flex:1;padding:8px 14px;background:var(--bg);border:1px solid var(--border);border-radius:20px;color:var(--text);font-size:14px;outline:none}
        #search:focus{border-color:var(--primary)}
        .stats{font-size:11px;color:var(--text2)}
        .content{flex:1;padding:8px;overflow-y:auto;-webkit-overflow-scrolling:touch}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px}
        @media(min-width:400px){.grid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}}
        @media(min-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px}}
        .card{aspect-ratio:2/3;border-radius:8px;overflow:hidden;cursor:pointer;position:relative;background:var(--surface)}
        .card:active{transform:scale(.96)}
        .card-poster{width:100%;height:100%;object-fit:cover;display:block;background:var(--border);opacity:0;transition:opacity .3s}
        .card-poster.loaded{opacity:1}
        .card-poster.error{opacity:.3}
        .card-overlay{position:absolute;bottom:0;left:0;right:0;padding:25px 8px 8px;background:linear-gradient(transparent,rgba(0,0,0,.95));opacity:0;transition:opacity .2s}
        .card:active .card-overlay{opacity:1}
        .card-overlay-title{font-size:11px;font-weight:600;line-height:1.3}
        .player{position:fixed;inset:0;background:#000;z-index:2000;display:none;flex-direction:column}
        .player.active{display:flex}
        .player-header{padding:12px 16px;display:flex;align-items:center;gap:12px;background:linear-gradient(rgba(0,0,0,.9),transparent);position:absolute;top:0;left:0;right:0;z-index:10}
        .player-title{flex:1;font-size:14px;font-weight:bold;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .btn-back{background:rgba(255,255,255,.1);border:none;color:var(--text);width:36px;height:36px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px}
        .btn-back:active{background:rgba(255,255,255,.2)}
        .video-container{flex:1;display:flex;align-items:center;justify-content:center;background:#000}
        video{width:100%;height:100%;max-height:100vh}
        .loading,.empty,.error{text-align:center;padding:40px 20px;color:var(--text2);font-size:14px}
        .loading::after{content:'';display:block;width:24px;height:24px;margin:15px auto;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
    </style>
</head>
<body>
    <div id="app">
        <div class="header">
            <div class="logo">MOVIES+</div>
            <input type="search" id="search" placeholder="Buscar película...">
            <div class="stats" id="stats">...</div>
        </div>
        <div class="content" id="content">
            <div class="grid" id="grid"><div class="loading">Cargando...</div></div>
        </div>
        <div class="player" id="player">
            <div class="player-header">
                <button class="btn-back" id="player-back">←</button>
                <div class="player-title" id="player-title"></div>
            </div>
            <div class="video-container">
                <video id="video" controls playsinline></video>
            </div>
        </div>
    </div>
    <script>
    (function(){
        const state={movies:[],page:0,hasMore:true,loading:false,search:'',currentView:'home'};
        let el={};
        document.addEventListener('DOMContentLoaded',init);
        function init(){
            el={grid:document.getElementById('grid'),content:document.getElementById('content'),search:document.getElementById('search'),stats:document.getElementById('stats'),player:document.getElementById('player'),playerBack:document.getElementById('player-back'),playerTitle:document.getElementById('player-title'),video:document.getElementById('video')};
            fetch('/api/stats').then(r=>r.json()).then(d=>{el.stats.textContent=d.movies+' películas'}).catch(()=>{});
            loadMovies(false);
            setupEvents();
            setupBackBtn();
        }
        function loadMovies(append){
            if(state.loading)return;
            if(append&&!state.hasMore)return;
            state.loading=true;
            if(!append){el.grid.innerHTML='<div class="loading">Cargando...</div>';state.page=0;state.hasMore=true;state.movies=[];}
            let url='/api/movies?page='+state.page+'&limit=550';
            if(state.search)url+='&q='+encodeURIComponent(state.search);
            fetch(url).then(r=>r.json()).then(data=>{
                if(!append)el.grid.innerHTML='';
                if(data.data.length===0&&!append){el.grid.innerHTML='<div class="empty">No se encontraron películas</div>';return;}
                data.data.forEach(m=>{const card=createCard(m);el.grid.appendChild(card);});
                state.movies=append?state.movies.concat(data.data):data.data;
                state.page++;
                state.hasMore=data.hasMore;
            }).catch(()=>{if(!append)el.grid.innerHTML='<div class="error">Error al cargar</div>';}).finally(()=>{state.loading=false;});
        }
        function createCard(m){
            const card=document.createElement('div');
            card.className='card';
            card.innerHTML='<img class="card-poster" data-src="'+esc(m.poster||'')+'" alt=""><div class="card-overlay"><div class="card-overlay-title">'+esc(m.title)+'</div></div>';
            const img=card.querySelector('.card-poster');
            imgObs.observe(img);
            card.addEventListener('click',()=>playMovie(m));
            return card;
        }
        const imgObs=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting){const img=e.target;const src=img.dataset.src;if(src){img.src=src;img.onload=()=>img.classList.add('loaded');img.onerror=()=>img.classList.add('error');}else{img.classList.add('error');}imgObs.unobserve(img);}});},{rootMargin:'100px'});
        function playMovie(m){
            state.currentView='player';
            history.pushState({view:'player'},'','#player');
            let url=m.url;
            if(url.startsWith('http://'))url='/video-proxy?url='+encodeURIComponent(url);
            el.video.src=url;
            el.playerTitle.textContent=m.title;
            el.player.classList.add('active');
            el.video.play().catch(()=>{});
        }
        function closePlayer(){el.video.pause();el.video.src='';el.player.classList.remove('active');state.currentView='home';}
        function setupEvents(){
            el.playerBack.addEventListener('click',closePlayer);
            let t;el.search.addEventListener('input',e=>{clearTimeout(t);t=setTimeout(()=>{state.search=e.target.value.trim();loadMovies(false);},300);});
            el.content.addEventListener('scroll',()=>{if(state.loading||!state.hasMore)return;const{scrollTop,scrollHeight,clientHeight}=el.content;if(scrollTop+clientHeight>=scrollHeight-300)loadMovies(true);});
            document.addEventListener('keydown',e=>{if(e.key==='Escape')handleBack();});
        }
        function setupBackBtn(){window.addEventListener('popstate',handleBack);}
        function handleBack(){if(state.currentView==='player')closePlayer();}
        function esc(s){if(!s)return'';return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]);}
    })();
    </script>
</body>
</html>`;

app.get('/',(req,res)=>{res.setHeader('Content-Type','text/html');res.send(HTML);});
app.get('/health',(req,res)=>{res.json({status:'ok',uptime:process.uptime(),movies:MOVIES_LIST.length});});
app.use((req,res)=>{res.status(404).json({status:'error',message:'No encontrada'});});

app.listen(PORT,'0.0.0.0',()=>{
    console.log('');
    console.log('══════════════════════════════════════');
    console.log('  🎬 MOVIES+ SERVER');
    console.log('══════════════════════════════════════');
    console.log('  🔗 Puerto: '+PORT);
    console.log('  🎥 Películas: '+MOVIES_LIST.length);
    console.log('══════════════════════════════════════');
});
