/* ================================================================
   캐논 배틀 — 포트리스 스타일 턴제 포격 게임
   자체 물리엔진(포물선 탄도 + 바람 + 지형 파괴 + 낙하/넉백)
   모바일 터치 우선, 데스크톱 키보드 지원
   ================================================================ */
'use strict';

// ---------------- 상수 ----------------
const WORLD_W = 1500;          // 월드 폭 (px)
const WORLD_H = 960;           // 월드 높이
const WATER_Y = WORLD_H - 46;  // 수면 y
const GRAVITY = 300;           // px/s^2
const WIND_ACCEL = 1.5;        // 바람 1당 가속도
const MAX_SPEED = 730;         // 파워 100 초기 속도 — 최강 역풍(22)에서도 가장 짧은 무기가 벽→벽(1476px) 도달하도록 산출
const WIND_MAX = 22;           // 바람 최대 세기
// 사거리는 속도²에 비례하므로, 속도를 √파워에 비례시켜 사거리가 파워에 정비례하게 한다
const speedFor = (power, w) => MAX_SPEED * Math.sqrt(clamp(power,8,100)/100) * w.speedMul;
const TURN_TIME = 30;          // 턴 제한(초)
const TANK_R = 16;             // 탱크 피격 반경
const CLOUD_DRAG = 1.7;        // 장애물 구름 내부 항력 (초당 속도 감쇠 비율)

// ---------------- 장애물 구름 패턴 ----------------
// 각 패턴은 {x,y,rx,ry,vx?,x0?,x1?} 타원 목록을 반환. k = 두께 배율
const CLOUD_PATTERNS = {
  none:   k => [],
  single: k => [ {x:WORLD_W*0.5, y:WORLD_H*0.36, rx:150*k, ry:52*k} ],
  band:   k => { const a=[]; for(let i=0;i<5;i++) a.push({x:WORLD_W*(0.22+i*0.14), y:WORLD_H*0.42+Math.sin(i)*14, rx:120*k, ry:36*k}); return a; },
  wall:   k => { const gap=1+Math.floor(Math.random()*2); const a=[];   // 세로 벽, 한 칸 비어 있음
                 for(let i=0;i<4;i++){ if(i===gap) continue; a.push({x:WORLD_W*0.5+(i%2?18:-18), y:WORLD_H*(0.2+i*0.11), rx:95*k, ry:40*k}); }
                 return a; },
  stairs: k => [ {x:WORLD_W*0.3, y:WORLD_H*0.5, rx:105*k, ry:40*k}, {x:WORLD_W*0.5, y:WORLD_H*0.37, rx:105*k, ry:40*k},
                 {x:WORLD_W*0.7, y:WORLD_H*0.25, rx:105*k, ry:40*k} ],
  moving: k => [ {x:WORLD_W*0.5, y:WORLD_H*0.36, rx:130*k, ry:48*k, vx:70, x0:WORLD_W*0.3, x1:WORLD_W*0.7},
                 {x:WORLD_W*0.45, y:WORLD_H*0.2, rx:100*k, ry:38*k, vx:-55, x0:WORLD_W*0.25, x1:WORLD_W*0.75} ],
  combo:  k => [ {x:WORLD_W*0.5, y:WORLD_H*0.28, rx:150*k, ry:50*k} ].concat(
                 [0,1,2].map(i=>({x:WORLD_W*(0.32+i*0.18), y:WORLD_H*0.5, rx:110*k, ry:34*k})) ),
};
const CLOUD_PATTERN_LIST = ['single','band','wall','stairs','moving','combo'];
// 점 (x,y)가 구름 안인지
function inCloud(c, x, y){ const dx=(x-c.x)/c.rx, dy=(y-c.y)/c.ry; return dx*dx+dy*dy < 1; }

// ---------------- 탱크 타입 ----------------
const TANK_TYPES = [
  {
    id:'canny', name:'캐니', desc:'균형 잡힌 표준 캐논.\n포격 계열 무기 체계.',
    hp:100, fuel:110, bodyColor:['#4aa3e8','#e85b4a'],
    weapons:[
      { label:'캐논탄', icon:'●', dmg:26, radius:42, speedMul:1.0, gravMul:1.0, count:1, spread:0 },
      { label:'더블샷', icon:'●●', dmg:17, radius:30, speedMul:1.0, gravMul:1.0, count:2, spread:4, ammo:3 },
      { label:'철갑탄', icon:'◆', dmg:38, radius:28, speedMul:1.05, gravMul:1.1, count:1, spread:0, ammo:2 },
    ],
  },
  {
    id:'missos', name:'미소스', desc:'빠르고 곧게 나는 로켓.\n미사일 계열 무기 체계.',
    hp:90, fuel:130, bodyColor:['#39b8a0','#e88f3a'],
    weapons:[
      { label:'로켓탄', icon:'➤', dmg:29, radius:32, speedMul:0.95, gravMul:0.88, count:1, spread:0 },
      { label:'트리플', icon:'➤➤➤', dmg:12, radius:24, speedMul:0.95, gravMul:0.88, count:3, spread:5, ammo:3 },
      { label:'유도탄', icon:'◎', dmg:24, radius:30, speedMul:0.9, gravMul:0.8, count:1, spread:0, ammo:2, homing:2.6 },
    ],
  },
  {
    id:'boomba', name:'붐바', desc:'느리지만 강력한 중전차.\n폭탄 계열 무기 체계.',
    hp:115, fuel:85, bodyColor:['#7d6ae0','#d64a7d'],
    weapons:[
      { label:'헤비탄', icon:'⬤', dmg:31, radius:50, speedMul:1.0, gravMul:1.05, count:1, spread:0 },
      { label:'메가봄', icon:'✸', dmg:44, radius:66, speedMul:1.0, gravMul:1.05, count:1, spread:0, ammo:2 },
      { label:'클러스터', icon:'✦', dmg:14, radius:26, speedMul:1.0, gravMul:1.05, count:1, spread:0, ammo:2, cluster:5 },
    ],
  },
];

// ---------------- 테마 ----------------
const THEMES = {
  grass:  { id:'grass', name:'초원', sky:['#6fc1f2','#b8e4fb','#e6f7ff'], sun:'#ffe158', cloudColor:'#ffffff', cloudAlpha:0.85,
            mountain:'#8fb8d9', mountainAlpha:0.45, dirt:['#b5793c','#8e5a28','#6d411a'], grain:'rgba(60,35,10,0.25)',
            rim:['#4fae3d','#7ed957'], water:['#48a7e8','#1e5f9e'], waterLine:'#bfe7ff', sinkText:'풍덩!', sinkColor:'#7fd4ff',
            props:'trees', particles:null },
  desert: { id:'desert', name:'사막', sky:['#f2934a','#fbcf86','#fff1cc'], sun:'#fff4b0', cloudColor:'#fff6e6', cloudAlpha:0.5,
            mountain:'#d9985c', mountainAlpha:0.5, dirt:['#eac878','#cfa052','#a3763a'], grain:'rgba(120,80,20,0.25)',
            rim:['#f4d88e','#fbe9b8'], water:['#e2bb6c','#b08538'], waterLine:'#f8e2a6', sinkText:'푹!', sinkColor:'#f3d48a',
            props:'cactus', particles:'sand' },
  snow:   { id:'snow', name:'설원', sky:['#9ccdf0','#d8ecfa','#ffffff'], sun:'#fff8d8', cloudColor:'#ffffff', cloudAlpha:0.9,
            mountain:'#b7d2e8', mountainAlpha:0.6, dirt:['#9a7a5a','#6e5440','#4e3a2c'], grain:'rgba(40,25,15,0.3)',
            rim:['#e6f2ff','#ffffff'], water:['#7fc6ea','#2f7fb0'], waterLine:'#e6f6ff', sinkText:'풍덩!', sinkColor:'#bfe7ff',
            props:'pines', particles:'snow' },
  volcano:{ id:'volcano', name:'화산', sky:['#2c0f22','#8a2a2a','#ec7a3c'], sun:'#ff8040', cloudColor:'#6a4a50', cloudAlpha:0.55,
            mountain:'#3a2230', mountainAlpha:0.75, dirt:['#4e3e3e','#2f2525','#1a1414'], grain:'rgba(255,130,40,0.2)',
            rim:['#5e4c4a','#7c6462'], water:['#ff8c2a','#c63c0a'], waterLine:'#ffe38a', sinkText:'치이익!', sinkColor:'#ffb347',
            props:'volcano', particles:'ash', lava:true },
  night:  { id:'night', name:'밤하늘', sky:['#070c24','#1a2a58','#3b4c86'], sun:null, moon:'#fff6cc', stars:true, cloudColor:'#7484aa', cloudAlpha:0.45,
            mountain:'#0f172e', mountainAlpha:0.85, dirt:['#5c4c3c','#3a2e22','#221a12'], grain:'rgba(0,0,0,0.3)',
            rim:['#2d6b3a','#3f8c4c'], water:['#17305c','#0a1a36'], waterLine:'#6f93d6', sinkText:'풍덩!', sinkColor:'#8fb3ff',
            props:'city', particles:'fireflies' },
};
const THEME_LIST = Object.keys(THEMES);

// ---------------- 유틸 ----------------
const clamp = (v,a,b)=> v<a?a : v>b?b : v;
const lerp = (a,b,t)=> a+(b-a)*t;
const rand = (a,b)=> a + Math.random()*(b-a);
const D2R = Math.PI/180;
// 시드 기반 의사난수(지형 텍스처 점 고정용)
function hash(n){ const s = Math.sin(n*127.1)*43758.5453; return s - Math.floor(s); }

// ---------------- 사운드 (WebAudio 합성) ----------------
const Sound = {
  ctx:null, muted:false,
  init(){ if(!this.ctx){ try{ this.ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } if(this.ctx && this.ctx.state==='suspended') this.ctx.resume(); },
  play(fn){ if(this.muted||!this.ctx) return; try{ fn(this.ctx); }catch(e){} },
  fire(){ this.play(c=>{ const o=c.createOscillator(), g=c.createGain();
    o.type='square'; o.frequency.setValueAtTime(340,c.currentTime);
    o.frequency.exponentialRampToValueAtTime(60,c.currentTime+0.28);
    g.gain.setValueAtTime(0.22,c.currentTime); g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+0.3);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime+0.32); }); },
  boom(big){ this.play(c=>{ const len=big?0.7:0.45, buf=c.createBuffer(1,c.sampleRate*len,c.sampleRate), d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++){ d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2); }
    const s=c.createBufferSource(), g=c.createGain(), f=c.createBiquadFilter();
    f.type='lowpass'; f.frequency.value=big?900:1400;
    g.gain.value=big?0.55:0.4; s.buffer=buf; s.connect(f).connect(g).connect(c.destination); s.start(); }); },
  splash(){ this.play(c=>{ const buf=c.createBuffer(1,c.sampleRate*0.4,c.sampleRate), d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++){ d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,1.2)*0.5; }
    const s=c.createBufferSource(), f=c.createBiquadFilter(), g=c.createGain();
    f.type='highpass'; f.frequency.value=1200; g.gain.value=0.3;
    s.buffer=buf; s.connect(f).connect(g).connect(c.destination); s.start(); }); },
  click(){ this.play(c=>{ const o=c.createOscillator(), g=c.createGain();
    o.type='sine'; o.frequency.value=660; g.gain.setValueAtTime(0.12,c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+0.08);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime+0.09); }); },
};

// ---------------- 지형 ----------------
class Terrain {
  constructor(){ this.ground = new Float32Array(WORLD_W); this.generate(); }
  generate(){
    const base = rand(WORLD_H*0.52, WORLD_H*0.62);
    const a1=rand(40,90), a2=rand(25,60), a3=rand(10,25);
    const f1=rand(1.1,1.9), f2=rand(2.5,4.2), f3=rand(6,9);
    const p1=rand(0,6.28), p2=rand(0,6.28), p3=rand(0,6.28);
    for(let x=0;x<WORLD_W;x++){
      const t = x/WORLD_W*Math.PI*2;
      let y = base + Math.sin(t*f1+p1)*a1 + Math.sin(t*f2+p2)*a2 + Math.sin(t*f3+p3)*a3;
      this.ground[x] = clamp(y, WORLD_H*0.28, WATER_Y-30);
    }
  }
  heightAt(x){ return this.ground[clamp(Math.round(x),0,WORLD_W-1)]; }
  slopeAt(x){
    const l=this.heightAt(x-8), r=this.heightAt(x+8);
    return Math.atan2(r-l, 16);
  }
  // 원형 크레이터: 폭발 원의 아래쪽 경계까지 지표를 깎는다
  crater(cx, cy, r){
    const x0=clamp(Math.floor(cx-r),0,WORLD_W-1), x1=clamp(Math.ceil(cx+r),0,WORLD_W-1);
    for(let x=x0;x<=x1;x++){
      const dx=x-cx, dy2=r*r-dx*dx;
      if(dy2<=0) continue;
      const dy=Math.sqrt(dy2), top=cy-dy, bot=cy+dy;
      const g=this.ground[x];
      if(top<=g && bot>g) this.ground[x]=Math.min(bot, WORLD_H-6);
    }
  }
}

// ---------------- 탱크 ----------------
class Tank {
  constructor(typeIdx, teamIdx, x, name, isAI){
    this.type = TANK_TYPES[typeIdx];
    this.team = teamIdx;             // 0 = P1(파랑계열), 1 = P2(빨강계열)
    this.name = name;
    this.isAI = isAI;
    this.x = x; this.y = 0;
    this.vx = 0; this.vy = 0; this.airborne = false;
    this.hp = this.type.hp; this.maxHp = this.type.hp;
    this.facing = teamIdx===0 ? 1 : -1;
    this.angle = 45;                 // 포신 각도(지면 기준 0~85)
    this.fuel = this.type.fuel;
    this.weaponIdx = 0;
    this.ammo = this.type.weapons.map(w => w.ammo===undefined ? Infinity : w.ammo);
    this.alive = true;
    this.tilt = 0;
    this.hitFlash = 0;
    this.recoil = 0;
  }
  get color(){ return this.type.bodyColor[this.team]; }
  weapon(){ return this.type.weapons[this.weaponIdx]; }
  // 다음 무기로 순환 (탄약 없는 무기는 건너뜀)
  nextWeapon(){
    const n=this.type.weapons.length;
    for(let k=1;k<=n;k++){
      const i=(this.weaponIdx+k)%n;
      if(this.ammo[i]>0){ this.weaponIdx=i; return; }
    }
  }
  consumeAmmo(){
    this.ammo[this.weaponIdx]--;
    if(this.ammo[this.weaponIdx]<=0) this.weaponIdx=0;
  }
  muzzle(angDeg){
    const a = this.barrelWorldAngle(angDeg);
    // 포신 피벗(차체 위 0,-10)을 차체 기울기만큼 회전시킨 실제 위치
    const px = this.x + 10*Math.sin(this.tilt);
    const py = this.y - 10*Math.cos(this.tilt);
    return {x:px + Math.cos(a)*30, y:py + Math.sin(a)*30};
  }
  barrelWorldAngle(angDeg){
    // 화면 y는 아래가 +. 위로 쏘려면 음의 각. 차체 기울기 포함(보이는 대로 나감)
    const ang = (angDeg===undefined ? this.angle : angDeg)*D2R;
    const base = this.facing===1 ? -ang : Math.PI + ang;
    return base + this.tilt;
  }
  settle(terrain, dt, game){
    const gy = terrain.heightAt(this.x) - 6;
    if(this.airborne){
      this.vy += GRAVITY*1.2*dt;
      this.x = clamp(this.x + this.vx*dt, 8, WORLD_W-8);
      this.y += this.vy*dt;
      if(this.y >= terrain.heightAt(this.x)-6){
        // 착지
        const impact = this.vy;
        this.y = terrain.heightAt(this.x)-6;
        this.airborne=false; this.vx=0; this.vy=0;
        if(impact>430 && this.alive){
          const dmg = Math.round((impact-430)*0.06);
          if(dmg>0) game.applyDamage(this, dmg, true);
        }
      }
      if(this.y > WATER_Y-4 && this.alive){ game.drown(this); }
    } else {
      // 지형이 깎이면 낙하 시작
      if(this.y < gy-2){ this.airborne=true; this.vy=0; }
      else this.y = gy;
      if(this.y > WATER_Y-4 && this.alive){ game.drown(this); }
    }
    const target = this.airborne?0:terrain.slopeAt(this.x);
    this.tilt = lerp(this.tilt, target, Math.min(1,dt*10));
    if(this.hitFlash>0) this.hitFlash-=dt;
    if(this.recoil>0) this.recoil=Math.max(0, this.recoil-dt*4.5);
  }
  move(dir, dt, terrain){
    if(this.fuel<=0 || this.airborne) return;
    const step = dir*46*dt;
    const nx = clamp(this.x+step, 12, WORLD_W-12);
    const dh = terrain.heightAt(nx) - terrain.heightAt(this.x);
    if(dh < -Math.abs(step)*1.9) return;   // 너무 가파른 오르막(위쪽=작은 y) 금지
    this.x = nx;
    this.facing = dir>0?1:-1;
    this.fuel = Math.max(0, this.fuel - 32*dt);
  }
}

// ---------------- 발사체 ----------------
class Projectile {
  constructor(x,y,vx,vy,weapon,owner,isChild){
    this.x=x; this.y=y; this.vx=vx; this.vy=vy;
    this.weapon=weapon; this.owner=owner; this.isChild=!!isChild;
    this.dead=false; this.trail=[]; this.age=0;
  }
  step(dt, game){
    this.age+=dt;
    const sub=4, h=dt/sub;
    // 유도탄: 발사 0.35초 후부터 가장 가까운 적을 향해 완만하게 선회
    let tgt=null;
    if(this.weapon.homing && this.age>0.35){
      let bd=1e9;
      for(const t of game.tanks){ if(!t.alive||t===this.owner) continue;
        const d=Math.hypot(t.x-this.x, t.y-this.y); if(d<bd){ bd=d; tgt=t; } }
    }
    for(let i=0;i<sub && !this.dead;i++){
      if(!tgt){
        this.vx += game.wind*WIND_ACCEL*h;
        this.vy += GRAVITY*this.weapon.gravMul*h;
      } else {
        // 락온 후 추진 비행: 중력/바람 무시
        // 속도 크기는 유지하고 진행 방향만 목표 쪽으로 제한 각속도(rad/s)로 선회
        const sp=Math.hypot(this.vx,this.vy);
        const want=Math.atan2((tgt.y-8)-this.y, tgt.x-this.x), cur=Math.atan2(this.vy,this.vx);
        let diff=want-cur; diff=Math.atan2(Math.sin(diff),Math.cos(diff));
        const na=cur+clamp(diff, -this.weapon.homing*h, this.weapon.homing*h);
        this.vx=Math.cos(na)*sp; this.vy=Math.sin(na)*sp;
      }
      // 장애물 구름 항력: 통과는 되지만 속도가 빠르게 줄어든다
      for(const o of game.obstacles){
        if(inCloud(o,this.x,this.y)){
          const f=Math.max(0, 1-CLOUD_DRAG*h); this.vx*=f; this.vy*=f;
          if(!this.inCloudNow){ o.wobble=1; game.fx.puff(this.x,this.y); }
          this.inCloudNow=true;
        }
      }
      if(!game.obstacles.some(o=>inCloud(o,this.x,this.y))) this.inCloudNow=false;
      // 새와 충돌: 새는 추락, 탄은 속도 절반
      for(const b of game.birds){
        if(b.hit) continue;
        const bdx=this.x-b.x, bdy=this.y-b.y;
        if(bdx*bdx+bdy*bdy < 13*13){
          b.hit=true; b.vy=-60; this.vx*=0.5; this.vy*=0.5;
          game.fx.feathers(b.x,b.y, game.theme.id==='night'?'#3a3a50':(game.theme.id==='snow'?'#ffffff':'#d8c8b0'));
          game.fx.pop(b.x,b.y-14,'새!','#fff');
        }
      }
      this.x += this.vx*h; this.y += this.vy*h;
      // 월드 밖
      if(this.x<-250 || this.x>WORLD_W+250 || this.y>WORLD_H+60){ this.dead=true; return; }
      // 물
      if(this.y>WATER_Y+4){ this.dead=true; game.splashAt(this.x); return; }
      // 탱크 직격
      for(const t of game.tanks){
        if(!t.alive) continue;
        if(this.age<0.08 && t===this.owner) continue;   // 발사 직후 자기 몸 무시
        const dx=this.x-t.x, dy=this.y-(t.y-8);
        if(dx*dx+dy*dy < TANK_R*TANK_R){ this.explode(game); return; }
      }
      // 지형
      if(this.x>=0 && this.x<WORLD_W && this.y >= game.terrain.heightAt(this.x)){
        this.explode(game); return;
      }
    }
    this.trail.push({x:this.x, y:this.y, t:0.5});
    if(this.trail.length>26) this.trail.shift();
  }
  explode(game){
    this.dead=true;
    game.explosionAt(this.x, this.y, this.weapon, this.owner);
    // 클러스터: 착탄 시 소형 자탄을 위로 흩뿌린다
    if(this.weapon.cluster && !this.isChild){
      const child={ label:'자탄', dmg:11, radius:22, speedMul:1, gravMul:1.05, count:1, spread:0 };
      for(let i=0;i<this.weapon.cluster;i++){
        const a=-Math.PI/2 + rand(-0.75,0.75), sp=rand(180,300);
        game.projectiles.push(new Projectile(this.x, this.y-6, Math.cos(a)*sp, Math.sin(a)*sp, child, this.owner, true));
      }
    }
  }
}

// ---------------- 파티클/이펙트 ----------------
class FX {
  constructor(){ this.parts=[]; this.pops=[]; this.rings=[]; this.smokes=[]; this.flashes=[]; }
  flash(x,y,a){ this.flashes.push({x,y,a,t:0}); }
  feathers(x,y,c){
    for(let i=0;i<10;i++){
      const a=rand(0,6.283), sp=rand(30,110);
      this.parts.push({x,y,vx:Math.cos(a)*sp, vy:Math.sin(a)*sp-40, life:rand(0.6,1.1), t:0, size:rand(2,4), c});
    }
  }
  puff(x,y){ for(let i=0;i<6;i++) this.smokes.push({x:x+rand(-8,8),y:y+rand(-6,6),r:rand(4,8),t:0,life:rand(0.4,0.7),white:true}); }
  burst(x,y,r,colors){
    for(let i=0;i<Math.min(46, r*0.9);i++){
      const a=rand(0,6.283), sp=rand(40, r*7);
      this.parts.push({x,y,vx:Math.cos(a)*sp, vy:Math.sin(a)*sp-rand(30,120),
        life:rand(0.4,0.9), t:0, size:rand(2,5), c:colors[i%colors.length]});
    }
    this.rings.push({x,y,r:4,max:r*1.4,t:0});
  }
  splash(x){
    for(let i=0;i<24;i++){
      this.parts.push({x:x+rand(-6,6), y:WATER_Y, vx:rand(-60,60), vy:rand(-260,-90),
        life:rand(0.4,0.8), t:0, size:rand(2,4), c:'#bfe7ff'});
    }
  }
  pop(x,y,text,color){ this.pops.push({x,y,text,color,t:0}); }
  smoke(x,y){ this.smokes.push({x,y,r:rand(3,6),t:0,life:rand(0.5,0.9)}); }
  update(dt){
    for(const p of this.parts){ p.t+=dt; p.x+=p.vx*dt; p.y+=p.vy*dt; p.vy+=520*dt; }
    this.parts=this.parts.filter(p=>p.t<p.life);
    for(const p of this.pops) p.t+=dt;
    this.pops=this.pops.filter(p=>p.t<1.2);
    for(const r of this.rings) r.t+=dt;
    this.rings=this.rings.filter(r=>r.t<0.45);
    for(const s of this.smokes){ s.t+=dt; s.y-=26*dt; s.r+=10*dt; }
    this.smokes=this.smokes.filter(s=>s.t<s.life);
    for(const f of this.flashes) f.t+=dt;
    this.flashes=this.flashes.filter(f=>f.t<0.13);
  }
}

// ================================================================
//                          게임 본체
// ================================================================
const canvas=document.getElementById('game');
const ctx=canvas.getContext('2d');

const Game = {
  state:'title',            // title | select | play | over
  mode:'1p',
  terrain:null, tanks:[], projectiles:[], fx:new FX(),
  current:0, wind:0, turnTimer:TURN_TIME,
  phase:'aim',              // aim | charging | flying | resolve | aiThink
  power:0, chargeDir:1,
  cam:{x:WORLD_W/2, y:WORLD_H/2, zoom:1, shake:0},
  camTarget:null,
  clouds:[], time:0,
  theme:THEMES.grass, props:[], ambient:[], obstacles:[],
  birds:[], birdRate:1, birdTimer:6,
  selP1:0, selP2:0, selStep:0,
  aiTimer:0, aiPlan:null, aiShots:0,
  banner:{text:'', t:99},
  lastImpact:null,
  turnSwitchDelay:0,

  newMatch(opts){
    opts = opts || {};
    this.theme = THEMES[opts.theme] || THEMES[THEME_LIST[Math.floor(Math.random()*THEME_LIST.length)]];
    this.terrain = new Terrain();
    this.projectiles=[]; this.fx=new FX();
    this.initAmbient();
    // 장애물 구름: 지정 패턴 또는 (빠른 대전) 50% 확률 랜덤
    let pat = opts.clouds;
    if(pat===undefined) pat = Math.random()<0.5 ? 'none' : CLOUD_PATTERN_LIST[Math.floor(Math.random()*CLOUD_PATTERN_LIST.length)];
    this.obstacles = (CLOUD_PATTERNS[pat]||CLOUD_PATTERNS.none)(opts.cloudK||1).map(c=>Object.assign({wobble:0, pat}, c));
    // 새: 0 없음 / 1 가끔 / 2 자주
    this.birds=[]; this.birdRate = opts.birds===undefined ? 1 : opts.birds;
    this.birdTimer = this.birdRate ? rand(4,9) : 1e9;
    this.aiShots = 0; this.turnCount = 0;
    const x1 = rand(140, 320), x2 = rand(WORLD_W-320, WORLD_W-140);
    const t1 = new Tank(this.selP1, 0, x1, 'P1 · '+TANK_TYPES[this.selP1].name, false);
    const aiIdx = this.mode==='1p' ? Math.floor(Math.random()*TANK_TYPES.length) : this.selP2;
    const t2 = new Tank(aiIdx, 1, x2, (this.mode==='1p'?'AI · ':'P2 · ')+TANK_TYPES[aiIdx].name, this.mode==='1p');
    t1.y = this.terrain.heightAt(t1.x)-6;
    t2.y = this.terrain.heightAt(t2.x)-6;
    this.tanks=[t1,t2];
    this.initProps();
    this.current = Math.floor(Math.random()*2);
    this.wind = Math.round(rand(-6,6));   // 첫 턴은 약한 바람으로 시작
    this.state='play';
    this.lastImpact=null;
    this.startTurn(true);
    UI.enterPlay();
  },

  cur(){ return this.tanks[this.current]; },

  // 테마 소품 위치 (탱크 스폰 지역 회피)
  initProps(){
    this.props=[];
    const n = 7;
    for(let i=0;i<n;i++){
      const x = 120 + (i+0.5)*(WORLD_W-240)/n + rand(-50,50);
      if(this.tanks.some && this.tanks.some(t=>Math.abs(t.x-x)<70)) continue;
      this.props.push({x, seed:hash(i*13.7+this.theme.id.length), kind:this.theme.props});
    }
  },
  // 대기 파티클 (화면 정규화 좌표 0~1)
  initAmbient(){
    this.ambient=[];
    const k=this.theme.particles; if(!k) return;
    const n = k==='snow'?90 : k==='ash'?55 : k==='sand'?45 : 28;
    for(let i=0;i<n;i++) this.ambient.push(this.spawnAmbient(k, true));
  },
  spawnAmbient(k, anywhere){
    const p={x:Math.random(), y:anywhere?Math.random():-0.02, s:rand(0.6,1.4), ph:rand(0,6.28)};
    if(k==='snow'){ p.vy=rand(0.05,0.1); p.vx=rand(-0.02,0.02); }
    else if(k==='ash'){ p.vy=rand(0.03,0.07); p.vx=rand(-0.03,0.01); p.y=anywhere?Math.random():-0.02; }
    else if(k==='sand'){ p.vy=rand(-0.01,0.01); p.vx=rand(0.35,0.7); p.x=anywhere?Math.random():-0.05; p.y=rand(0.3,0.95); }
    else { p.vy=rand(-0.01,0.01); p.vx=rand(-0.02,0.02); p.y=rand(0.3,0.9); }   // 반딧불
    return p;
  },
  // ---------- 새 ----------
  spawnFlock(){
    const dir = Math.random()<0.5 ? 1 : -1;
    const n = 3 + Math.floor(Math.random()*3);
    const y = WORLD_H*rand(0.14,0.42), sp = rand(70,115)*dir;
    const x0 = dir===1 ? -60 : WORLD_W+60;
    for(let i=0;i<n;i++){
      this.birds.push({ x:x0 - dir*i*26, y:y + Math.abs(i-(n-1)/2)*12, vx:sp, vy:0, ph:rand(0,6.28), hit:false, rot:0 });
    }
  },
  updateBirds(dt){
    if(this.birdRate){
      this.birdTimer-=dt;
      if(this.birdTimer<=0){ this.spawnFlock(); this.birdTimer = this.birdRate>=2 ? rand(5,10) : rand(10,20); }
    }
    for(const b of this.birds){
      b.ph+=dt*9;
      if(b.hit){ b.vy+=GRAVITY*0.9*dt; b.rot+=dt*7; b.x+=b.vx*0.3*dt; b.y+=b.vy*dt; }
      else { b.x+=b.vx*dt; b.y+=Math.sin(b.ph*0.4)*6*dt; }
    }
    this.birds=this.birds.filter(b=> b.x>-120 && b.x<WORLD_W+120 && b.y<WATER_Y+10 && !(b.hit && b.y>=this.terrain.heightAt(b.x)));
  },
  updateAmbient(dt){
    const k=this.theme.particles; if(!k) return;
    const wdir = this.wind/WIND_MAX;
    for(let i=0;i<this.ambient.length;i++){
      const p=this.ambient[i]; p.ph+=dt;
      p.x += (p.vx + (k==='snow'||k==='ash' ? wdir*0.03 : 0))*dt;
      p.y += p.vy*dt + (k==='snow'?Math.sin(p.ph*1.5)*0.004*dt:0);
      if(p.y>1.05 || p.x>1.1 || p.x<-0.1){ this.ambient[i]=this.spawnAmbient(k,false); }
    }
  },
  foe(){ return this.tanks[1-this.current]; },

  startTurn(first){
    const t=this.cur();
    if(!t.alive){ this.endMatch(); return; }
    if(!first){
      // 바람은 턴이 지날수록 범위가 넓어지고, 이전 값에서 점진적으로 변한다
      this.turnCount++;
      const cap = Math.min(WIND_MAX, 5 + this.turnCount*2.5);
      const delta = Math.min(12, 3 + this.turnCount*1.2);
      this.wind = Math.round(clamp(this.wind + rand(-delta,delta), -cap, cap));
    }
    // 턴 시작 시 자동으로 적 방향을 바라본다
    const foe = this.tanks[1-this.current];
    if(foe && foe.alive) t.facing = foe.x > t.x ? 1 : -1;
    t.fuel = t.type.fuel;
    this.turnTimer = TURN_TIME;
    this.power = 0;
    this.phase = t.isAI ? 'aiThink' : 'aim';
    this.aiTimer = 0; this.aiPlan=null;
    this.camTarget = t;
    this.showBanner(t.name + ' 차례!');
    UI.refresh();
  },

  nextTurn(){
    const alive=this.tanks.filter(t=>t.alive);
    if(alive.length<=1){ this.endMatch(); return; }
    this.current = 1-this.current;
    this.startTurn(false);
  },

  endMatch(){
    const alive=this.tanks.filter(t=>t.alive);
    this.state='over';
    const title = alive.length===1 ? alive[0].name+' 승리! 🏆' : '무승부!';
    document.getElementById('overTitle').textContent=title;
    UI.show('overScreen');
    UI.hidePlayUI();
  },

  showBanner(text){ this.banner={text,t:0}; },

  fire(){
    const t=this.cur(), w=t.weapon();
    t.consumeAmmo();
    const speed = speedFor(this.power, w);
    const a = t.barrelWorldAngle();
    const m = t.muzzle();
    for(let i=0;i<w.count;i++){
      const off = (i-(w.count-1)/2)*w.spread*D2R;
      const vx=Math.cos(a+off)*speed, vy=Math.sin(a+off)*speed;
      this.projectiles.push(new Projectile(m.x,m.y,vx,vy,w,t));
    }
    this.fx.flash(m.x, m.y, a);
    t.recoil = 1;
    Sound.fire();
    this.cam.shake=Math.max(this.cam.shake, 4);
    this.phase='flying';
    UI.refresh();
  },

  explosionAt(x,y,w,owner){
    this.terrain.crater(x,y,w.radius);
    this.fx.burst(x,y,w.radius,['#ffdd55','#ff8833','#ff4422','#ffffff','#775533']);
    for(let i=0;i<6;i++) this.fx.smoke(x+rand(-w.radius/2,w.radius/2), y+rand(-w.radius/2,0));
    Sound.boom(w.radius>55);
    this.cam.shake=Math.max(this.cam.shake, w.radius*0.28);
    this.lastImpact={x,y,t:0};
    for(const t of this.tanks){
      if(!t.alive) continue;
      const dx=t.x-x, dy=(t.y-8)-y, dist=Math.sqrt(dx*dx+dy*dy);
      const eff = w.radius*1.45;
      if(dist<eff){
        const dmg = Math.round(w.dmg * (1-dist/eff));
        if(dmg>0) this.applyDamage(t, dmg, false);
        // 넉백
        const kb = 240*(1-dist/eff);
        const nx = dist>0.01 ? dx/dist : 0;
        t.vx += nx*kb; t.vy += -Math.abs(kb)*0.55 - 40;
        t.airborne=true;
      }
    }
  },

  applyDamage(t, dmg, isFall){
    t.hp=Math.max(0, t.hp-dmg);
    t.hitFlash=0.35;
    this.fx.pop(t.x, t.y-34, '-'+dmg, isFall?'#ffb03e':'#ff3e3e');
    if(t.hp<=0 && t.alive){
      t.alive=false;
      this.fx.burst(t.x, t.y-8, 60, ['#ffdd55','#ff8833','#ff4422','#888']);
      Sound.boom(true);
    }
    UI.refresh();
  },

  drown(t){
    t.alive=false; t.hp=0;
    this.fx.splash(t.x);
    Sound.splash();
    this.fx.pop(t.x, WATER_Y-30, this.theme.sinkText, this.theme.sinkColor);
    UI.refresh();
  },

  splashAt(x){ this.fx.splash(x); Sound.splash(); },

  // ---------- AI ----------
  simulateShot(from, angleDeg, power, w){
    const a = from.barrelWorldAngle(angleDeg);
    const speed=speedFor(power, w);
    const m = from.muzzle(angleDeg);
    let x=m.x, y=m.y;
    let vx=Math.cos(a)*speed, vy=Math.sin(a)*speed;
    const h=1/60;
    for(let i=0;i<60*8;i++){
      vx+=this.wind*WIND_ACCEL*h; vy+=GRAVITY*w.gravMul*h;
      for(const o of this.obstacles){ if(inCloud(o,x,y)){ const f=Math.max(0,1-CLOUD_DRAG*h); vx*=f; vy*=f; } }
      x+=vx*h; y+=vy*h;
      if(x<-200||x>WORLD_W+200||y>WORLD_H+50) return null;
      if(y>WATER_Y) return {x,y:WATER_Y};
      if(x>=0&&x<WORLD_W&&y>=this.terrain.heightAt(x)) return {x,y};
    }
    return null;
  },
  aiDecide(){
    const me=this.cur(), foe=this.foe();
    me.facing = foe.x>me.x?1:-1;
    // 무기 선택: 기본은 1번, 탄약이 남은 특수 무기를 상대 HP 45 이하이거나 35% 확률로 사용
    me.weaponIdx=0;
    const specials=me.type.weapons.map((w,i)=>i).filter(i=>i>0 && me.ammo[i]>0);
    if(specials.length && (foe.hp<=45 || Math.random()<0.35)){
      me.weaponIdx=specials[Math.floor(Math.random()*specials.length)];
    }
    const w=me.weapon();
    let best=null;
    for(let ang=15; ang<=80; ang+=4){
      for(let pow=22; pow<=100; pow+=4){
        const hit=this.simulateShot(me,ang,pow,w);
        if(!hit) continue;
        const d=Math.abs(hit.x-foe.x)+Math.abs(hit.y-(foe.y-8))*0.4;
        if(!best || d<best.d) best={ang,pow,d};
      }
    }
    if(!best) best={ang:55, pow:70, d:999};
    // 성장형 난이도: 첫 발은 크게 빗나가고, 쏠수록 감을 잡아 오차가 줄어든다
    const skill = Math.min(1, this.aiShots*0.18);          // 0 → 1 (약 6발째 최고조)
    const powErr = lerp(5.5, 1.2, skill);
    const angErr = lerp(2.6, 0.6, skill);
    best.pow = clamp(best.pow + rand(-powErr,powErr), 12, 100);
    best.ang = clamp(best.ang + rand(-angErr,angErr), 5, 85);
    this.aiShots++;
    return best;
  },

  // ---------- 업데이트 ----------
  update(dt){
    this.time+=dt;
    for(const c of this.clouds){ c.x+=c.v*dt; if(c.x>WORLD_W+220) c.x=-220; }
    for(const o of this.obstacles){
      if(o.vx){ o.x+=o.vx*dt; if(o.x<o.x0){ o.x=o.x0; o.vx=Math.abs(o.vx); } if(o.x>o.x1){ o.x=o.x1; o.vx=-Math.abs(o.vx); } }
      if(o.wobble>0) o.wobble=Math.max(0,o.wobble-dt*2.5);
    }
    if(this.state!=='play'){ return; }

    this.fx.update(dt);
    this.updateAmbient(dt);
    this.updateBirds(dt);
    if(this.lastImpact) this.lastImpact.t+=dt;
    if(this.banner.t<3) this.banner.t+=dt;

    for(const t of this.tanks) t.settle(this.terrain, dt, this);

    // 사망으로 매치 종료 확인 (발사체 없을 때)
    const alive=this.tanks.filter(t=>t.alive);
    if(alive.length<=1 && this.projectiles.length===0 && this.phase!=='resolve'){
      this.phase='resolve'; this.turnSwitchDelay=1.2;
    }

    switch(this.phase){
      case 'aim': {
        this.turnTimer-=dt;
        if(this.turnTimer<=0){ this.showBanner('시간 초과!'); this.phase='resolve'; this.turnSwitchDelay=0.9; }
        const t=this.cur();
        if(Input.left)  t.move(-1,dt,this.terrain);
        if(Input.right) t.move( 1,dt,this.terrain);
        if(Input.angUp)   t.angle=clamp(t.angle+34*dt, 0, 85);
        if(Input.angDown) t.angle=clamp(t.angle-34*dt, 0, 85);
        this.camTarget=t;
        break;
      }
      case 'charging': {
        this.turnTimer-=dt;
        this.power=clamp(this.power+62*dt, 0, 100);
        if(this.turnTimer<=0 || this.power>=100){ this.fire(); }
        break;
      }
      case 'aiThink': {
        this.aiTimer+=dt;
        const t=this.cur();
        if(!this.aiPlan && this.aiTimer>0.9){ this.aiPlan=this.aiDecide(); UI.refresh(); }
        if(this.aiPlan){
          // 각도를 목표로 서서히 이동
          const diff=this.aiPlan.ang-t.angle;
          if(Math.abs(diff)>0.25) t.angle+=Math.sign(diff)*Math.min(Math.abs(diff), 40*dt);
          else if(this.aiTimer>1.6){
            this.power=clamp(this.power+70*dt, 0, this.aiPlan.pow);
            if(this.power>=this.aiPlan.pow-0.5) this.fire();
          }
        }
        this.camTarget=t;
        break;
      }
      case 'flying': {
        for(const p of this.projectiles) p.step(dt,this);
        this.projectiles=this.projectiles.filter(p=>!p.dead);
        if(this.projectiles.length){
          // 카메라: 첫 발사체 추적
          this.camTarget=this.projectiles[0];
        } else {
          this.phase='resolve'; this.turnSwitchDelay=1.15;
        }
        break;
      }
      case 'resolve': {
        this.turnSwitchDelay-=dt;
        const anyAirborne=this.tanks.some(t=>t.alive&&t.airborne);
        if(this.turnSwitchDelay<=0 && !anyAirborne){
          const alive2=this.tanks.filter(t=>t.alive);
          if(alive2.length<=1) this.endMatch();
          else this.nextTurn();
        }
        break;
      }
    }

    // ---------- 카메라 ----------
    const vw=canvas.width, vh=canvas.height;
    const zoomH = vh/WORLD_H, zoomW = vw/WORLD_W;
    this.cam.zoom = Math.max(zoomH, Math.min(zoomW*2.2, zoomH*1.35));
    if(this.cam.zoom*WORLD_W < vw) this.cam.zoom = vw/WORLD_W;
    const viewW=vw/this.cam.zoom, viewH=vh/this.cam.zoom;
    let tx=this.camTarget?this.camTarget.x:WORLD_W/2;
    let ty=this.camTarget?this.camTarget.y:WORLD_H*0.6;
    tx=clamp(tx, viewW/2, WORLD_W-viewW/2);
    ty=clamp(ty, viewH/2, WORLD_H-viewH/2);
    const k=Math.min(1, dt*3.2);
    this.cam.x=lerp(this.cam.x, tx, k);
    this.cam.y=lerp(this.cam.y, ty, k);
    this.cam.shake=Math.max(0, this.cam.shake - dt*26);

    UI.tick();
  },
};

// ================================================================
//                          렌더링
// ================================================================
const Render = {
  draw(){
    const vw=canvas.width, vh=canvas.height;
    ctx.clearRect(0,0,vw,vh);
    this.sky(vw,vh);
    if(Game.state==='title'||Game.state==='select'){ return; }

    const cam=Game.cam;
    const sx=rand(-cam.shake,cam.shake), sy=rand(-cam.shake,cam.shake);
    ctx.save();
    ctx.translate(vw/2+sx, vh/2+sy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    this.mountains();
    this.terrain();
    this.props();
    this.birds();
    for(const t of Game.tanks) this.tank(t);
    this.projectiles();
    this.obstacleClouds();
    this.effects();
    this.water();
    this.powerGauge();
    ctx.restore();
    this.ambient(vw,vh);
    this.countdown(vw,vh);
  },

  // 5초 이하 남으면 화면 상단 중앙에 큰 카운트다운
  countdown(vw,vh){
    if(Game.state!=='play') return;
    if(Game.phase!=='aim' && Game.phase!=='charging') return;
    if(Game.cur().isAI) return;
    if(Game.turnTimer>5.99) return;
    const n=Math.ceil(Game.turnTimer);
    const frac=Game.turnTimer-Math.floor(Game.turnTimer);
    const pulse=1+0.35*frac;
    ctx.save();
    ctx.translate(vw/2, vh*0.2);
    ctx.scale(pulse,pulse);
    ctx.font='bold 64px Trebuchet MS, sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.lineWidth=8; ctx.strokeStyle='rgba(255,255,255,0.9)';
    ctx.strokeText(n,0,0);
    ctx.fillStyle='#e02818';
    ctx.fillText(n,0,0);
    ctx.restore();
  },

  sky(vw,vh){
    const th=Game.theme;
    const g=ctx.createLinearGradient(0,0,0,vh);
    g.addColorStop(0,th.sky[0]); g.addColorStop(0.55,th.sky[1]); g.addColorStop(1,th.sky[2]);
    ctx.fillStyle=g; ctx.fillRect(0,0,vw,vh);
    // 별
    if(th.stars){
      ctx.save(); ctx.fillStyle='#fff';
      for(let i=0;i<90;i++){
        const x=hash(i*1.3)*vw, y=hash(i*2.7)*vh*0.6, r=0.6+hash(i*5.1)*1.6;
        ctx.globalAlpha=0.4+0.6*Math.abs(Math.sin(Game.time*1.5+i));
        ctx.beginPath(); ctx.arc(x,y,r,0,6.283); ctx.fill();
      }
      ctx.restore();
    }
    // 해 / 달
    const sunX=vw*0.82, sunY=vh*0.16;
    ctx.save();
    if(th.sun){
      ctx.globalAlpha=0.9;
      const rg=ctx.createRadialGradient(sunX,sunY,4,sunX,sunY,60);
      rg.addColorStop(0,'#fff9c8'); rg.addColorStop(0.5,th.sun); rg.addColorStop(1,'rgba(255,225,88,0)');
      ctx.fillStyle=rg; ctx.beginPath(); ctx.arc(sunX,sunY,60,0,6.283); ctx.fill();
    } else if(th.moon){
      const rg=ctx.createRadialGradient(sunX,sunY,10,sunX,sunY,70);
      rg.addColorStop(0,'rgba(255,246,204,0.35)'); rg.addColorStop(1,'rgba(255,246,204,0)');
      ctx.fillStyle=rg; ctx.beginPath(); ctx.arc(sunX,sunY,70,0,6.283); ctx.fill();
      ctx.fillStyle=th.moon; ctx.beginPath(); ctx.arc(sunX,sunY,26,0,6.283); ctx.fill();
      ctx.fillStyle=th.sky[0]; ctx.globalAlpha=0.9; ctx.beginPath(); ctx.arc(sunX+11,sunY-6,22,0,6.283); ctx.fill();
    }
    ctx.restore();
    // 구름 (화면 좌표 고정 비율)
    ctx.save();
    for(const c of Game.clouds){
      const x=(c.x/WORLD_W)*vw, y=c.y*vh;
      ctx.globalAlpha=th.cloudAlpha;
      ctx.fillStyle=th.cloudColor;
      const s=c.s*(vh/500);
      ctx.beginPath();
      ctx.arc(x,y,18*s,0,6.283); ctx.arc(x+20*s,y-8*s,15*s,0,6.283);
      ctx.arc(x+40*s,y,17*s,0,6.283); ctx.arc(x+20*s,y+6*s,16*s,0,6.283);
      ctx.fill();
    }
    ctx.restore();
  },

  mountains(){
    const th=Game.theme;
    ctx.save();
    ctx.globalAlpha=th.mountainAlpha;
    ctx.fillStyle=th.mountain;
    if(th.props==='city'){
      // 도시 스카이라인
      for(let i=0;i<26;i++){
        const w=40+hash(i*3.1)*50, x=i*(WORLD_W/26), h=80+hash(i*7.7)*220, y=WORLD_H*0.62-h;
        ctx.fillRect(x,y,w,h+WORLD_H);
      }
      ctx.globalAlpha=0.9; ctx.fillStyle='#ffe38a';
      for(let i=0;i<26;i++){
        const w=40+hash(i*3.1)*50, x=i*(WORLD_W/26), h=80+hash(i*7.7)*220, y=WORLD_H*0.62-h;
        for(let r=0;r<h-14;r+=16) for(let c=6;c<w-8;c+=12){
          if(hash(i*91+r*3+c*7)<0.35) ctx.fillRect(x+c,y+r+6,5,7);
        }
      }
    } else if(th.props==='volcano'){
      // 큰 화산 실루엣 + 분화구 발광
      ctx.beginPath(); ctx.moveTo(0,WORLD_H*0.62);
      ctx.lineTo(WORLD_W*0.35,WORLD_H*0.62); ctx.lineTo(WORLD_W*0.50,WORLD_H*0.22);
      ctx.lineTo(WORLD_W*0.56,WORLD_H*0.22); ctx.lineTo(WORLD_W*0.72,WORLD_H*0.62);
      ctx.lineTo(WORLD_W,WORLD_H*0.62); ctx.lineTo(WORLD_W,WORLD_H); ctx.lineTo(0,WORLD_H); ctx.closePath(); ctx.fill();
      const gl=ctx.createRadialGradient(WORLD_W*0.53,WORLD_H*0.22,2,WORLD_W*0.53,WORLD_H*0.22,90);
      gl.addColorStop(0,'rgba(255,140,40,0.9)'); gl.addColorStop(1,'rgba(255,80,20,0)');
      ctx.globalAlpha=0.7+0.3*Math.sin(Game.time*3); ctx.fillStyle=gl;
      ctx.beginPath(); ctx.arc(WORLD_W*0.53,WORLD_H*0.22,90,0,6.283); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(0,WORLD_H*0.55);
      for(let x=0;x<=WORLD_W;x+=60){
        ctx.lineTo(x, WORLD_H*0.42 + Math.sin(x*0.008+2)*60 + Math.sin(x*0.02)*24);
      }
      ctx.lineTo(WORLD_W,WORLD_H); ctx.lineTo(0,WORLD_H); ctx.closePath(); ctx.fill();
      if(th.props==='pines'){ // 설산: 능선을 따라 얇은 눈 띠
        ctx.globalAlpha=0.95; ctx.strokeStyle='#ffffff'; ctx.lineWidth=14; ctx.lineJoin='round';
        ctx.beginPath();
        for(let x=0;x<=WORLD_W;x+=60){
          const y=WORLD_H*0.42 + Math.sin(x*0.008+2)*60 + Math.sin(x*0.02)*24 + 4;
          x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  },

  birds(){
    const th=Game.theme;
    const bat = th.id==='night';
    const col = bat?'#2a2a3e' : th.id==='snow'?'#f4f8ff' : th.id==='volcano'?'#3a2a2a' : '#4a3a30';
    for(const b of Game.birds){
      ctx.save();
      ctx.translate(b.x,b.y);
      if(b.vx<0) ctx.scale(-1,1);
      ctx.rotate(b.rot);
      const flap = b.hit ? 0.2 : Math.sin(b.ph);
      ctx.fillStyle=col; ctx.strokeStyle=col; ctx.lineWidth=2.2; ctx.lineCap='round';
      // 몸통
      ctx.beginPath(); ctx.ellipse(0,0,7,3.2,0,0,6.283); ctx.fill();
      // 머리/부리
      ctx.beginPath(); ctx.arc(7,-1,2.6,0,6.283); ctx.fill();
      ctx.fillStyle=bat?col:'#ffb347'; ctx.beginPath(); ctx.moveTo(9.5,-1); ctx.lineTo(13,0); ctx.lineTo(9.5,1); ctx.closePath(); ctx.fill();
      // 날개 (펄럭임)
      ctx.strokeStyle=col; ctx.lineWidth= bat?3:2.4;
      ctx.beginPath(); ctx.moveTo(-1,0); ctx.quadraticCurveTo(-6,-10*flap-2, -14,-9*flap); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-1,0); ctx.quadraticCurveTo(6,-10*flap-2, 13,-8*flap); ctx.stroke();
      if(bat){ // 박쥐 날개막
        ctx.globalAlpha=0.85; ctx.beginPath(); ctx.moveTo(-1,0); ctx.quadraticCurveTo(-6,-10*flap-2,-14,-9*flap); ctx.lineTo(-9,-2*flap+2); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-1,0); ctx.quadraticCurveTo(6,-10*flap-2,13,-8*flap); ctx.lineTo(8,-2*flap+2); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
  },

  // 장애물 구름 (배경 구름과 구분: 진하고 외곽선+그림자, 맞으면 출렁임)
  obstacleClouds(){
    const th=Game.theme;
    for(const o of Game.obstacles){
      const wob=1+Math.sin(Game.time*14)*0.06*o.wobble;
      ctx.save();
      ctx.translate(o.x,o.y); ctx.scale(wob, 1/wob);
      const blobs=[];
      const n=Math.max(4, Math.round(o.rx/32));
      for(let i=0;i<n;i++){
        const t=(i/(n-1))*2-1;             // -1..1
        const bx=t*o.rx*0.78, by=Math.sin(i*2.3)*o.ry*0.25;
        const r=o.ry*(0.75+0.35*(1-Math.abs(t)))+4;
        blobs.push([bx,by,r]);
      }
      const draw=(dx,dy,rk)=>{ ctx.beginPath(); for(const [bx,by,r] of blobs) ctx.moveTo(bx+dx+r*rk,by+dy), ctx.arc(bx+dx,by+dy,r*rk,0,6.283); ctx.fill(); };
      // 그림자
      ctx.fillStyle='rgba(0,0,0,0.18)'; draw(6,10,1);
      // 본체 (테마색 살짝 반영)
      const dark = th.id==='night'?'#6f7f9f' : th.id==='volcano'?'#8a6a6a' : '#b9c9d9';
      const light= th.id==='night'?'#aab6cc' : th.id==='volcano'?'#d8b8a8' : '#ffffff';
      ctx.fillStyle='rgba(60,80,110,0.6)'; draw(0,0,1.07);   // 외곽 테두리 역할
      ctx.fillStyle=dark; draw(0,4,1.0);
      ctx.fillStyle=light; draw(0,-2,0.96);
      ctx.restore();
    }
  },

  // 지면에 붙은 테마 소품
  props(){
    const th=Game.theme, g=Game.terrain;
    for(const pr of Game.props){
      const x=pr.x, y=g.heightAt(x)-2, sc=0.8+pr.seed*0.5;
      ctx.save(); ctx.translate(x,y); ctx.scale(sc,sc);
      if(pr.kind==='trees'){
        ctx.fillStyle='#7a4a22'; ctx.fillRect(-3,-22,6,24);
        ctx.fillStyle='#2f8a3a'; ctx.beginPath(); ctx.arc(0,-30,16,0,6.283); ctx.arc(-11,-22,11,0,6.283); ctx.arc(11,-22,11,0,6.283); ctx.fill();
        ctx.fillStyle='#55b24a'; ctx.beginPath(); ctx.arc(-4,-34,9,0,6.283); ctx.fill();
      } else if(pr.kind==='cactus'){
        ctx.fillStyle='#3f8f46'; ctx.strokeStyle='#2b6a32'; ctx.lineWidth=1.5;
        this.rr(-5,-40,10,42,5); ctx.fill(); ctx.stroke();
        this.rr(-17,-30,8,16,4); ctx.fill(); ctx.stroke(); ctx.fillRect(-14,-18,10,5);
        this.rr(9,-24,8,14,4); ctx.fill(); ctx.stroke(); ctx.fillRect(4,-14,8,5);
      } else if(pr.kind==='pines'){
        ctx.fillStyle='#5a3a22'; ctx.fillRect(-2.5,-14,5,16);
        ctx.fillStyle='#1f5e3a';
        for(let i=0;i<3;i++){ const w=18-i*4, yy=-14-i*12; ctx.beginPath(); ctx.moveTo(-w,yy); ctx.lineTo(0,yy-16); ctx.lineTo(w,yy); ctx.closePath(); ctx.fill(); }
        ctx.fillStyle='#ffffff';
        for(let i=0;i<3;i++){ const w=18-i*4, yy=-14-i*12; ctx.beginPath(); ctx.moveTo(-w*0.7,yy-4); ctx.lineTo(0,yy-16); ctx.lineTo(w*0.7,yy-4); ctx.lineTo(0,yy-9); ctx.closePath(); ctx.fill(); }
      } else if(pr.kind==='volcano'){
        // 마른 나무
        ctx.strokeStyle='#1a1010'; ctx.lineWidth=3; ctx.lineCap='round';
        ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,-30); ctx.moveTo(0,-18); ctx.lineTo(-10,-30); ctx.moveTo(0,-24); ctx.lineTo(9,-34); ctx.stroke();
        ctx.fillStyle='rgba(255,120,40,0.5)'; ctx.beginPath(); ctx.arc(6,-4,3,0,6.283); ctx.fill();
      } else if(pr.kind==='city'){
        // 가로등
        ctx.fillStyle='#2a2f44'; ctx.fillRect(-2,-38,4,40); ctx.fillRect(-2,-38,12,3);
        const gl=ctx.createRadialGradient(10,-34,1,10,-34,30);
        gl.addColorStop(0,'rgba(255,230,150,0.7)'); gl.addColorStop(1,'rgba(255,230,150,0)');
        ctx.fillStyle=gl; ctx.beginPath(); ctx.arc(10,-34,30,0,6.283); ctx.fill();
        ctx.fillStyle='#fff3b0'; ctx.beginPath(); ctx.arc(10,-35,3,0,6.283); ctx.fill();
      }
      ctx.restore();
    }
  },

  // 대기 파티클 (화면 공간)
  ambient(vw,vh){
    const th=Game.theme, k=th.particles; if(!k || Game.state!=='play') return;
    ctx.save();
    for(const p of Game.ambient){
      const x=p.x*vw, y=p.y*vh;
      if(k==='snow'){ ctx.globalAlpha=0.85; ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(x,y,2.2*p.s*(vh/500),0,6.283); ctx.fill(); }
      else if(k==='ash'){ ctx.globalAlpha=0.6; ctx.fillStyle=p.s>1.1?'#ff9a4a':'#8a8080'; ctx.fillRect(x,y,2.5*p.s,2.5*p.s); }
      else if(k==='sand'){ ctx.globalAlpha=0.35; ctx.strokeStyle='#fff0c0'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x-14*p.s,y+1); ctx.stroke(); }
      else { ctx.globalAlpha=0.3+0.7*Math.abs(Math.sin(p.ph*2)); ctx.fillStyle='#d8ff7a'; ctx.beginPath(); ctx.arc(x,y,2*p.s,0,6.283); ctx.fill(); }
    }
    ctx.restore();
  },

  terrain(){
    const g=Game.terrain.ground;
    // 흙
    const th=Game.theme;
    const grd=ctx.createLinearGradient(0,WORLD_H*0.3,0,WORLD_H);
    grd.addColorStop(0,th.dirt[0]); grd.addColorStop(0.6,th.dirt[1]); grd.addColorStop(1,th.dirt[2]);
    ctx.fillStyle=grd;
    ctx.beginPath(); ctx.moveTo(0,WORLD_H);
    for(let x=0;x<WORLD_W;x+=2) ctx.lineTo(x,g[x]);
    ctx.lineTo(WORLD_W,WORLD_H); ctx.closePath(); ctx.fill();
    // 흙 알갱이
    ctx.fillStyle=th.grain;
    for(let i=0;i<160;i++){
      const x=Math.floor(hash(i*3.7)*WORLD_W);
      const depth=hash(i*7.1)*140+18;
      const y=g[x]+depth;
      if(y<WORLD_H-8) ctx.fillRect(x,y,3,3);
    }
    // 잔디
    ctx.lineWidth=7; ctx.strokeStyle=th.rim[0]; ctx.lineJoin='round';
    ctx.beginPath();
    for(let x=0;x<WORLD_W;x+=2){ x===0?ctx.moveTo(x,g[x]-1):ctx.lineTo(x,g[x]-1); }
    ctx.stroke();
    ctx.lineWidth=3; ctx.strokeStyle=th.rim[1];
    ctx.beginPath();
    for(let x=0;x<WORLD_W;x+=2){ x===0?ctx.moveTo(x,g[x]-3):ctx.lineTo(x,g[x]-3); }
    ctx.stroke();
  },

  water(){
    ctx.save();
    const t=Game.time;
    ctx.globalAlpha=0.85;
    const th=Game.theme;
    const grd=ctx.createLinearGradient(0,WATER_Y,0,WORLD_H);
    grd.addColorStop(0,th.water[0]); grd.addColorStop(1,th.water[1]);
    ctx.fillStyle=grd;
    if(th.lava){ ctx.globalAlpha=1; ctx.shadowColor='#ff8c2a'; ctx.shadowBlur=30; }
    ctx.beginPath(); ctx.moveTo(0,WORLD_H); ctx.lineTo(0,WATER_Y);
    for(let x=0;x<=WORLD_W;x+=24) ctx.lineTo(x, WATER_Y + Math.sin(x*0.03+t*2.2)*3);
    ctx.lineTo(WORLD_W,WORLD_H); ctx.closePath(); ctx.fill();
    ctx.shadowBlur=0;
    ctx.globalAlpha=th.lava?0.8:0.5; ctx.strokeStyle=th.waterLine; ctx.lineWidth=th.lava?3:2;
    ctx.beginPath();
    for(let x=0;x<=WORLD_W;x+=24){ const y=WATER_Y+Math.sin(x*0.03+t*2.2)*3; x===0?ctx.moveTo(x,y):ctx.lineTo(x,y); }
    ctx.stroke();
    ctx.restore();
  },

  tank(t){
    if(!t.alive) return;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.tilt);
    // 접지 그림자
    ctx.save();
    ctx.globalAlpha=0.28; ctx.fillStyle='#1a2a10';
    ctx.beginPath(); ctx.ellipse(0,2.5,23,4,0,0,6.283); ctx.fill();
    ctx.restore();
    const aLocal = t.facing===1 ? -t.angle*D2R : Math.PI + t.angle*D2R;
    this.tankBody(ctx, t.type.id, t.color, t.facing, aLocal, t.recoil);
    // 피격 플래시
    if(t.hitFlash>0){ ctx.globalAlpha=Math.min(0.7,t.hitFlash*2); ctx.fillStyle='#fff'; this.rr(-20,-28,40,26,8); ctx.fill(); ctx.globalAlpha=1; }
    ctx.restore();

    // 이름 + HP바 (기울기 미적용)
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.font='bold 11px Trebuchet MS, sans-serif';
    ctx.textAlign='center';
    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.85)';
    ctx.strokeText(t.name, 0, -44);
    ctx.fillStyle=t.team===0?'#0b62a8':'#c0281a';
    ctx.fillText(t.name, 0, -44);
    ctx.fillStyle='rgba(0,0,0,0.35)'; this.rr(-19,-41,38,6,3); ctx.fill();
    ctx.fillStyle=t.hp>t.maxHp*0.35?'#57d13e':'#ff5030';
    const w=36*(t.hp/t.maxHp);
    if(w>0.5){ this.rr(-18,-40,w,4,2); ctx.fill(); }
    // 현재 턴 표시 화살표
    if(Game.state==='play' && Game.cur()===t && (Game.phase==='aim'||Game.phase==='charging'||Game.phase==='aiThink')){
      const bob=Math.sin(Game.time*5)*3;
      ctx.fillStyle='#ffd23e'; ctx.strokeStyle='#8a5a00'; ctx.lineWidth=1.5;
      ctx.beginPath();
      ctx.moveTo(0,-56+bob); ctx.lineTo(-7,-66+bob); ctx.lineTo(7,-66+bob); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();

    // 조준 가이드 (사람 차례, 조준 중)
    if(Game.state==='play' && Game.cur()===t && !t.isAI && (Game.phase==='aim'||Game.phase==='charging')){
      const a=t.barrelWorldAngle(), m=t.muzzle();
      const ex=m.x+Math.cos(a)*120, ey=m.y+Math.sin(a)*120;
      ctx.save();
      ctx.lineCap='round';
      // 어두운 외곽선 + 밝은 주황 점선
      ctx.setLineDash([8,6]);
      ctx.strokeStyle='rgba(40,20,0,0.8)'; ctx.lineWidth=5;
      ctx.beginPath(); ctx.moveTo(m.x,m.y); ctx.lineTo(ex,ey); ctx.stroke();
      ctx.strokeStyle='#ffb020'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(m.x,m.y); ctx.lineTo(ex,ey); ctx.stroke();
      // 끝점 화살촉
      ctx.setLineDash([]);
      ctx.fillStyle='#ffb020'; ctx.strokeStyle='rgba(40,20,0,0.8)'; ctx.lineWidth=1.5;
      ctx.translate(ex,ey); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(8,0); ctx.lineTo(-4,-6); ctx.lineTo(-4,6); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  },

  projectiles(){
    for(const p of Game.projectiles){
      // 궤적
      ctx.save();
      for(let i=0;i<p.trail.length;i++){
        const tr=p.trail[i];
        ctx.globalAlpha=i/p.trail.length*0.5;
        ctx.fillStyle='#fff';
        ctx.beginPath(); ctx.arc(tr.x,tr.y,2.4,0,6.283); ctx.fill();
      }
      ctx.restore();
      // 탄체
      ctx.save();
      ctx.translate(p.x,p.y);
      ctx.rotate(Math.atan2(p.vy,p.vx));
      const w=p.weapon, sc=p.isChild?0.6:(w.radius>=60?1.35:1);
      ctx.scale(sc,sc);
      if(w.homing){
        // 유도탄: 붉은 탄두 + 긴 화염
        ctx.fillStyle='#ff4a3a'; ctx.beginPath(); ctx.ellipse(0,0,8,3.8,0,0,6.283); ctx.fill();
        ctx.fillStyle='#ffe08a'; ctx.beginPath(); ctx.ellipse(-9,0,6,2.4,0,0,6.283); ctx.fill();
        ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(4,0,1.6,0,6.283); ctx.fill();
      } else if(w.cluster){
        // 클러스터: 둥근 폭탄 + 노란 띠
        ctx.fillStyle='#3a3a48'; ctx.beginPath(); ctx.arc(0,0,6.5,0,6.283); ctx.fill();
        ctx.strokeStyle='#ffd23e'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(0,0,4,0,6.283); ctx.stroke();
      } else {
        ctx.fillStyle='#2f2f38';
        ctx.beginPath(); ctx.ellipse(0,0,7,4.5,0,0,6.283); ctx.fill();
        ctx.fillStyle='#ff8833';
        ctx.beginPath(); ctx.ellipse(-6,0,4,2.6,0,0,6.283); ctx.fill();
      }
      ctx.restore();
    }
    // 직전 착탄 지점 마커
    const li=Game.lastImpact;
    if(li && li.t<4 && Game.projectiles.length===0){
      ctx.save();
      ctx.globalAlpha=Math.max(0, 1-li.t/4);
      ctx.strokeStyle='#ff3e3e'; ctx.lineWidth=2.5;
      ctx.beginPath();
      ctx.moveTo(li.x-8,li.y-8); ctx.lineTo(li.x+8,li.y+8);
      ctx.moveTo(li.x+8,li.y-8); ctx.lineTo(li.x-8,li.y+8);
      ctx.stroke();
      ctx.restore();
    }
  },

  effects(){
    const fx=Game.fx;
    for(const s of fx.smokes){
      ctx.save(); ctx.globalAlpha=(s.white?0.7:0.35)*(1-s.t/s.life);
      ctx.fillStyle=s.white?'#ffffff':'#9a9a9a';
      ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,6.283); ctx.fill(); ctx.restore();
    }
    for(const p of fx.parts){
      ctx.save(); ctx.globalAlpha=1-p.t/p.life;
      ctx.fillStyle=p.c; ctx.fillRect(p.x-p.size/2,p.y-p.size/2,p.size,p.size);
      ctx.restore();
    }
    for(const r of fx.rings){
      const k=r.t/0.45;
      ctx.save(); ctx.globalAlpha=(1-k)*0.8;
      ctx.strokeStyle='#fff'; ctx.lineWidth=4*(1-k)+1;
      ctx.beginPath(); ctx.arc(r.x,r.y,r.r+(r.max-r.r)*k,0,6.283); ctx.stroke();
      ctx.restore();
    }
    // 총구 화염
    for(const f of fx.flashes){
      const k=f.t/0.13, s=1-k;
      ctx.save();
      ctx.translate(f.x,f.y); ctx.rotate(f.a);
      ctx.globalCompositeOperation='lighter';
      ctx.globalAlpha=s;
      ctx.fillStyle='#ffca55';
      ctx.beginPath();
      ctx.moveTo(0,-4*s); ctx.lineTo(16*s,-1.5*s); ctx.lineTo(24*s,0);
      ctx.lineTo(16*s,1.5*s); ctx.lineTo(0,4*s); ctx.closePath(); ctx.fill();
      ctx.fillStyle='#fff3c0';
      ctx.beginPath(); ctx.arc(3,0,4.5*s,0,6.283); ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.textAlign='center'; ctx.font='bold 20px Trebuchet MS, sans-serif';
    for(const p of fx.pops){
      const k=p.t/1.2;
      ctx.globalAlpha=1-k;
      ctx.lineWidth=4; ctx.strokeStyle='rgba(255,255,255,0.9)';
      ctx.strokeText(p.text, p.x, p.y-36*k);
      ctx.fillStyle=p.color;
      ctx.fillText(p.text, p.x, p.y-36*k);
    }
    ctx.restore();
  },

  // 차지 중 탱크 머리 위 대형 파워 게이지 (손가락에 가리지 않게)
  powerGauge(){
    if(Game.state!=='play') return;
    const charging = Game.phase==='charging' || (Game.phase==='aiThink' && Game.power>0);
    if(!charging) return;
    const t=Game.cur();
    const w=96, h=14, x=t.x-w/2, y=t.y-86;
    ctx.save();
    ctx.fillStyle='rgba(0,0,0,0.45)';
    this.rr(x-3,y-3,w+6,h+6,7); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.25)';
    this.rr(x,y,w,h,5); ctx.fill();
    const g=ctx.createLinearGradient(x,0,x+w,0);
    g.addColorStop(0,'#ffe63e'); g.addColorStop(0.6,'#ff8c1a'); g.addColorStop(1,'#ff2d1a');
    ctx.fillStyle=g;
    const fw=w*Game.power/100;
    if(fw>1){ this.rr(x,y,fw,h,5); ctx.fill(); }
    ctx.strokeStyle='#fff'; ctx.lineWidth=2;
    this.rr(x,y,w,h,5); ctx.stroke();
    ctx.fillStyle='#fff'; ctx.font='bold 13px Trebuchet MS, sans-serif';
    ctx.textAlign='center';
    ctx.fillText(Math.round(Game.power), x+w/2, y-6);
    ctx.restore();
  },

  rr(x,y,w,h,r){ this.rrOn(ctx,x,y,w,h,r); },
  rrOn(c,x,y,w,h,r){
    c.beginPath();
    c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r);
    c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath();
  },

  // ---------- 프리미엄 탱크 스프라이트 (타입별 실루엣) ----------
  // 원점 = 접지 중심. 포신 피벗은 물리와 동일하게 (0,-10), 길이 30 유지.
  tankBody(c, typeId, color, facing, aLocal, recoil){
    const dark=this.shade(color,-52), mid=this.shade(color,-18),
          light=this.shade(color,44), glint=this.shade(color,85);
    const M1='#23232c', M2='#3c3c48', M3='#5b5b6c', M4='#8b8b9e'; // 금속 팔레트

    // ── 포신 (차체 뒤에 그림) ──
    c.save();
    c.translate(0,-10);
    c.rotate(aLocal);
    c.translate(-recoil*5, 0);           // 발사 반동
    const bg=c.createLinearGradient(0,-5,0,5);
    bg.addColorStop(0,M4); bg.addColorStop(0.45,M3); bg.addColorStop(1,M1);
    c.fillStyle=bg;
    if(typeId==='missos'){                // 얇고 긴 로켓 런처
      this.rrOn(c,2,-3.2,29,6.4,3); c.fill();
      c.fillStyle=M1; this.rrOn(c,24,-4.2,7,8.4,2.5); c.fill();  // 발사구 확장부
      c.fillStyle='#151519'; c.beginPath(); c.ellipse(30.5,0,1.6,3,0,0,6.283); c.fill();
    } else if(typeId==='boomba'){         // 두꺼운 중포신 + 머즐브레이크
      this.rrOn(c,2,-4.6,28,9.2,4); c.fill();
      c.fillStyle=M2; this.rrOn(c,22,-5.6,4,11.2,2); c.fill();
      this.rrOn(c,27.5,-5.6,4,11.2,2); c.fill();
      c.fillStyle='#151519'; c.beginPath(); c.ellipse(31.5,0,1.6,3.6,0,0,6.283); c.fill();
    } else {                              // 캐니: 표준 포신 + 슬리브
      this.rrOn(c,2,-4,29,8,3.5); c.fill();
      c.fillStyle=mid; this.rrOn(c,6,-4.8,7,9.6,3); c.fill();    // 컬러 슬리브
      c.fillStyle='#151519'; c.beginPath(); c.ellipse(30.5,0,1.5,3.2,0,0,6.283); c.fill();
    }
    // 포신 상단 하이라이트
    c.fillStyle='rgba(255,255,255,0.35)';
    this.rrOn(c,4,-3.8,24,2,1.5); c.fill();
    c.restore();

    // ── 무한궤도 ──
    const tg=c.createLinearGradient(0,-9,0,4);
    tg.addColorStop(0,M2); tg.addColorStop(1,M1);
    c.fillStyle=tg;
    this.rrOn(c,-21,-9,42,13,6.5); c.fill();
    c.strokeStyle='#111116'; c.lineWidth=1.4;
    this.rrOn(c,-21,-9,42,13,6.5); c.stroke();
    // 트랙 패턴
    c.strokeStyle='rgba(0,0,0,0.5)'; c.lineWidth=1;
    for(let i=-18;i<=18;i+=4){ c.beginPath(); c.moveTo(i,-8.5); c.lineTo(i-1.5,3.2); c.stroke(); }
    // 로드휠
    for(let i=-14;i<=14;i+=7){
      const wg=c.createRadialGradient(i-1,-3.5,0.5,i,-2.5,3.6);
      wg.addColorStop(0,M4); wg.addColorStop(0.7,M2); wg.addColorStop(1,'#111116');
      c.fillStyle=wg;
      c.beginPath(); c.arc(i,-2.5,3.6,0,6.283); c.fill();
      c.fillStyle=M1; c.beginPath(); c.arc(i,-2.5,1.2,0,6.283); c.fill();
    }

    // ── 차체 (타입별 실루엣) ──
    const hull=c.createLinearGradient(0,-26,0,-7);
    hull.addColorStop(0,light); hull.addColorStop(0.55,color); hull.addColorStop(1,mid);
    c.fillStyle=hull; c.strokeStyle=dark; c.lineWidth=1.8;

    if(typeId==='missos'){
      // 날렵한 쐐기형 차체
      c.beginPath();
      c.moveTo(-19*facing,-9); c.lineTo(-17*facing,-19); c.lineTo(-4*facing,-22);
      c.lineTo(14*facing,-20); c.lineTo(20*facing,-13); c.lineTo(19*facing,-9);
      c.closePath(); c.fill(); c.stroke();
      // 미사일 포드 (후방 상단, 튜브 3개)
      c.save(); c.translate(-9*facing,-24);
      c.fillStyle=M2; this.rrOn(c,-6,-4,12,7,2.5); c.fill();
      c.strokeStyle='#111116'; c.lineWidth=1; this.rrOn(c,-6,-4,12,7,2.5); c.stroke();
      for(let i=-3.5;i<=3.5;i+=3.5){
        c.fillStyle='#151519'; c.beginPath(); c.arc(i*facing,-0.5,1.5,0,6.283); c.fill();
        c.fillStyle='#ff8c4a'; c.beginPath(); c.arc(i*facing,-0.5,0.7,0,6.283); c.fill();
      }
      c.restore();
      // 콕핏 캐노피
      const cg=c.createLinearGradient(0,-24,0,-18);
      cg.addColorStop(0,'#e8fbff'); cg.addColorStop(1,'#5fb8e8');
      c.fillStyle=cg;
      c.beginPath(); c.ellipse(6*facing,-20.5,5.5,3.4,0,Math.PI,0); c.closePath(); c.fill();
      c.strokeStyle=dark; c.lineWidth=1.2; c.beginPath(); c.ellipse(6*facing,-20.5,5.5,3.4,0,Math.PI,0); c.stroke();
      // 스피드 스트라이프
      c.fillStyle=glint; c.globalAlpha=0.8;
      c.beginPath();
      c.moveTo(-16*facing,-17); c.lineTo(16*facing,-15.5); c.lineTo(16*facing,-13.5); c.lineTo(-17*facing,-14.5);
      c.closePath(); c.fill(); c.globalAlpha=1;
    } else if(typeId==='boomba'){
      // 육중한 장갑 차체
      this.rrOn(c,-19,-24,38,17,4.5); c.fill(); c.stroke();
      // 전면 경사 장갑판
      c.fillStyle=mid;
      c.beginPath();
      c.moveTo(19*facing,-24); c.lineTo(23*facing,-15); c.lineTo(19*facing,-7);
      c.closePath(); c.fill();
      c.strokeStyle=dark; c.stroke();
      // 장갑 리벳
      c.fillStyle=dark;
      for(const [rx,ry] of [[-15,-21],[-15,-10],[15,-21],[15,-10],[0,-21]]){
        c.beginPath(); c.arc(rx,ry,1.1,0,6.283); c.fill();
      }
      // 포탑 (각진 큐폴라)
      const tg2=c.createLinearGradient(0,-32,0,-22);
      tg2.addColorStop(0,light); tg2.addColorStop(1,color);
      c.fillStyle=tg2;
      this.rrOn(c,-9,-31,18,8,3); c.fill();
      c.strokeStyle=dark; c.lineWidth=1.5; this.rrOn(c,-9,-31,18,8,3); c.stroke();
      c.fillStyle=glint; this.rrOn(c,-7,-30.2,14,2,1); c.fill();
      // 배기관 2개
      c.fillStyle=M2;
      this.rrOn(c,-19.5*facing-(facing===1?0:3),-29,3,6,1.5); c.fill();
      this.rrOn(c,-15.5*facing-(facing===1?0:3),-27,3,4,1.5); c.fill();
    } else {
      // 캐니: 클래식 라운드 차체
      this.rrOn(c,-17,-21,34,14,6); c.fill(); c.stroke();
      // 사이드 스커트 스트라이프
      c.fillStyle=glint; c.globalAlpha=0.85;
      this.rrOn(c,-15,-12,30,2.6,1.3); c.fill(); c.globalAlpha=1;
      // 패널 라인
      c.strokeStyle='rgba(0,0,0,0.25)'; c.lineWidth=1;
      c.beginPath(); c.moveTo(-6,-21); c.lineTo(-6,-12); c.stroke();
      c.beginPath(); c.moveTo(8,-21); c.lineTo(8,-12); c.stroke();
      // 포탑 돔
      const dg=c.createRadialGradient(-2,-24,1,0,-20,10);
      dg.addColorStop(0,glint); dg.addColorStop(0.55,light); dg.addColorStop(1,color);
      c.fillStyle=dg;
      c.beginPath(); c.arc(0,-20,9.5,Math.PI,0); c.closePath(); c.fill();
      c.strokeStyle=dark; c.lineWidth=1.6;
      c.beginPath(); c.arc(0,-20,9.5,Math.PI,0); c.stroke();
      // 해치
      c.fillStyle=light; c.beginPath(); c.arc(0,-24,3,0,6.283); c.fill();
      c.strokeStyle=dark; c.lineWidth=1; c.beginPath(); c.arc(0,-24,3,0,6.283); c.stroke();
    }

    // ── 공통: 스펙큘러 하이라이트 + 안테나 ──
    c.save();
    c.globalAlpha=0.22; c.fillStyle='#ffffff';
    c.beginPath(); c.ellipse(-5*facing,-20,10,3.4,-0.25*facing,0,6.283); c.fill();
    c.restore();
    c.strokeStyle=M2; c.lineWidth=1.3;
    c.beginPath(); c.moveTo(-12*facing,-24); c.lineTo(-16*facing,-36); c.stroke();
    c.fillStyle='#ffd23e';
    c.beginPath(); c.arc(-16*facing,-37,1.9,0,6.283); c.fill();
    c.fillStyle='rgba(255,255,255,0.7)';
    c.beginPath(); c.arc(-16.6*facing,-37.6,0.7,0,6.283); c.fill();
  },
  shade(hex, amt){
    const n=parseInt(hex.slice(1),16);
    let r=(n>>16)+amt, g=((n>>8)&0xff)+amt, b=(n&0xff)+amt;
    r=clamp(r,0,255); g=clamp(g,0,255); b=clamp(b,0,255);
    return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
  },
};

// ================================================================
//                        입력 / UI
// ================================================================
const Input = { left:false, right:false, angUp:false, angDown:false };

const UI = {
  els:{},
  init(){
    const ids=['titleScreen','selectScreen','hud','controls','overScreen','banner','btnMute',
      'btn1p','btn2p','tankCards','btnStart','selectTitle','btnLeft','btnRight','btnAngUp','btnAngDown',
      'angleVal','btnWeapon','btnFlip','btnFire','powerFill','fuelFill','windArrow','windVal','turnTimer',
      'hpP1','hpP2','btnAgain','btnMenu'];
    for(const id of ids) this.els[id]=document.getElementById(id);

    this.els.btn1p.addEventListener('click', ()=>{ Sound.init(); Sound.click(); Game.mode='1p'; this.openSelect(); });
    this.els.btn2p.addEventListener('click', ()=>{ Sound.init(); Sound.click(); Game.mode='2p'; this.openSelect(); });
    this.els.btnStart.addEventListener('click', ()=>{
      Sound.click();
      if(Game.mode==='2p' && Game.selStep===0){
        Game.selP1=this.selIdx; Game.selStep=1; this.selIdx=-1;
        this.renderCards('P2 탱크 선택');
        this.els.btnStart.disabled=true;
        return;
      }
      if(Game.mode==='2p'){ Game.selP2=this.selIdx; } else { Game.selP1=this.selIdx; }
      this.show(null); Game.newMatch();
    });
    this.els.btnAgain.addEventListener('click', ()=>{ Sound.click(); this.show(null); Game.newMatch(); });
    this.els.btnMenu.addEventListener('click', ()=>{ Sound.click(); Game.state='title'; this.hidePlayUI(); this.show('titleScreen'); });
    this.els.btnMute.addEventListener('click', ()=>{ Sound.muted=!Sound.muted; this.els.btnMute.textContent=Sound.muted?'🔇':'🔊'; });

    // 홀드 버튼
    this.hold(this.els.btnLeft,  v=>Input.left=v);
    this.hold(this.els.btnRight, v=>Input.right=v);
    this.hold(this.els.btnAngUp,   v=>Input.angUp=v);
    this.hold(this.els.btnAngDown, v=>Input.angDown=v);

    // 방향 전환
    this.els.btnFlip.addEventListener('click', ()=>{
      const t=Game.cur();
      if(Game.state!=='play' || t.isAI || Game.phase!=='aim') return;
      t.facing*=-1; Sound.click();
    });

    // 무기 전환
    this.els.btnWeapon.addEventListener('click', ()=>{
      const t=Game.cur();
      if(Game.state!=='play' || t.isAI || Game.phase!=='aim') return;
      t.nextWeapon(); Sound.click(); this.refresh();
    });

    // 발사(홀드 차지)
    const fireDown=e=>{ e.preventDefault();
      Sound.init();
      if(Game.state!=='play' || Game.cur().isAI || Game.phase!=='aim') return;
      Game.phase='charging'; Game.power=0;
      this.els.btnFire.classList.add('pressed');
    };
    const fireUp=e=>{ e.preventDefault();
      this.els.btnFire.classList.remove('pressed');
      if(Game.state==='play' && Game.phase==='charging' && !Game.cur().isAI) Game.fire();
    };
    this.els.btnFire.addEventListener('pointerdown', fireDown);
    this.els.btnFire.addEventListener('pointerup', fireUp);
    this.els.btnFire.addEventListener('pointercancel', fireUp);
    this.els.btnFire.addEventListener('pointerleave', e=>{ if(Game.phase==='charging') fireUp(e); });

    // 키보드 (데스크톱 편의)
    window.addEventListener('keydown', e=>{
      if(Game.state!=='play' || Game.cur().isAI) return;
      if(e.code==='ArrowLeft') Input.left=true;
      if(e.code==='ArrowRight') Input.right=true;
      if(e.code==='ArrowUp') Input.angUp=true;
      if(e.code==='ArrowDown') Input.angDown=true;
      if(e.code==='Space' && Game.phase==='aim' && !e.repeat){ Sound.init(); Game.phase='charging'; Game.power=0; }
      if(e.code==='KeyX' && Game.phase==='aim') this.els.btnWeapon.click();
      if(e.code==='KeyF' && Game.phase==='aim') this.els.btnFlip.click();
    });
    window.addEventListener('keyup', e=>{
      if(e.code==='ArrowLeft') Input.left=false;
      if(e.code==='ArrowRight') Input.right=false;
      if(e.code==='ArrowUp') Input.angUp=false;
      if(e.code==='ArrowDown') Input.angDown=false;
      if(e.code==='Space' && Game.phase==='charging') Game.fire();
    });
  },

  hold(el, setter){
    const down=e=>{ e.preventDefault(); Sound.init(); setter(true); el.classList.add('pressed'); };
    const up=e=>{ e.preventDefault(); setter(false); el.classList.remove('pressed'); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  },

  show(id){
    for(const s of ['titleScreen','selectScreen','overScreen']) this.els[s].classList.add('hidden');
    if(id) this.els[id].classList.remove('hidden');
  },

  openSelect(){
    Game.selStep=0; this.selIdx=-1;
    this.show('selectScreen');
    this.renderCards(Game.mode==='2p' ? 'P1 탱크 선택' : '탱크 선택');
    this.els.btnStart.disabled=true;
  },

  renderCards(title){
    this.els.selectTitle.textContent=title;
    const box=this.els.tankCards; box.innerHTML='';
    const team = (Game.mode==='2p' && Game.selStep===1)?1:0;
    TANK_TYPES.forEach((tt,i)=>{
      const card=document.createElement('div');
      card.className='tank-card';
      const cv=document.createElement('canvas'); cv.width=140; cv.height=64;
      card.appendChild(cv);
      const n=document.createElement('div'); n.className='tname'; n.textContent=tt.name; card.appendChild(n);
      const d=document.createElement('div'); d.className='tdesc';
      d.textContent=`${tt.desc.replace('\n',' ')} HP ${tt.hp} · `+tt.weapons.map(w=>w.label+(w.ammo?`×${w.ammo}`:'')).join(' / ');
      card.appendChild(d);
      this.drawCardTank(cv, tt.bodyColor[team], tt.id);
      card.addEventListener('click', ()=>{
        Sound.init(); Sound.click();
        box.querySelectorAll('.tank-card').forEach(c=>c.classList.remove('sel'));
        card.classList.add('sel');
        this.selIdx=i; this.els.btnStart.disabled=false;
      });
      box.appendChild(card);
    });
  },

  drawCardTank(cv, color, typeId){
    const c=cv.getContext('2d');
    c.clearRect(0,0,cv.width,cv.height);
    c.save();
    c.translate(cv.width/2, cv.height-8);
    c.scale(1.35,1.35);
    Render.tankBody(c, typeId, color, 1, -35*D2R, 0);
    c.restore();
  },

  enterPlay(){
    this.els.hud.classList.remove('hidden');
    this.els.controls.classList.remove('hidden');
    this.els.btnMute.classList.remove('hidden');
    this.refresh();
  },
  hidePlayUI(){
    this.els.hud.classList.add('hidden');
    this.els.controls.classList.add('hidden');
    this.els.banner.classList.add('hidden');
  },

  refresh(){
    if(Game.state!=='play' && Game.state!=='over') return;
    const [t1,t2]=Game.tanks;
    this.setHp(this.els.hpP1, t1);
    this.setHp(this.els.hpP2, t2);
    // 바람
    const w=Game.wind;
    this.els.windVal.textContent = '바람 '+Math.abs(w);
    this.els.windArrow.textContent = w>1?'▶':(w<-1?'◀':'●');
    this.els.windArrow.style.transform=`scale(${1+Math.abs(w)/28})`;
    this.els.windArrow.style.color = Math.abs(w)>18?'#d8321e':'#0b62a8';
    // 무기
    const cur=Game.cur();
    const wp=cur.weapon();
    const am=cur.ammo[cur.weaponIdx];
    this.els.btnWeapon.textContent = `${wp.icon} ${wp.label}${am===Infinity?'':` (${am})`}`;
    // 컨트롤 표시/숨김 (AI 턴엔 비활성 느낌)
    this.els.controls.classList.toggle('ai-dim', cur.isAI);
    this.els.controls.style.pointerEvents = cur.isAI?'none':'auto';
  },

  setHp(panel, t){
    panel.querySelector('.pname').textContent=t.name;
    panel.querySelector('.hpfill').style.width=Math.max(0,t.hp/t.maxHp*100)+'%';
  },

  tick(){
    if(Game.state!=='play') return;
    const t=Game.cur();
    this.els.angleVal.textContent=Math.round(t.angle)+'°';
    this.els.fuelFill.style.width=(t.fuel/t.type.fuel*100)+'%';
    this.els.powerFill.style.width=Game.power+'%';
    this.els.turnTimer.textContent = (Game.phase==='aim'||Game.phase==='charging') ? '⏱'+Math.ceil(Game.turnTimer) : '—';
    // 탄 비행/정산 중에는 조작부를 내려 착탄 지점이 보이게
    const hide = Game.phase==='flying' || Game.phase==='resolve';
    this.els.controls.classList.toggle('faded', hide);
    // 배너
    if(Game.banner.t<1.6){
      this.els.banner.textContent=Game.banner.text;
      this.els.banner.classList.remove('hidden');
    } else this.els.banner.classList.add('hidden');
  },
};

// ================================================================
//                        부팅 / 루프
// ================================================================
function resize(){
  const dpr=Math.min(window.devicePixelRatio||1, 2);
  canvas.width=Math.round(innerWidth*dpr);
  canvas.height=Math.round(innerHeight*dpr);
  canvas.style.width=innerWidth+'px';
  canvas.style.height=innerHeight+'px';
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', ()=>setTimeout(resize,150));
resize();

// 구름 초기화
for(let i=0;i<5;i++){
  Game.clouds.push({x:rand(0,WORLD_W), y:rand(0.05,0.3), s:rand(0.7,1.4), v:rand(6,16)});
}

UI.init();

let last=performance.now();
function loop(now){
  const dt=Math.min(0.05,(now-last)/1000);
  last=now;
  Game.update(dt);
  Render.draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
