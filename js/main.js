/* ================================================================
   캐논 배틀 — 포트리스 스타일 턴제 포격 게임
   자체 물리엔진(포물선 탄도 + 바람 + 지형 파괴 + 낙하/넉백)
   모바일 터치 우선, 데스크톱 키보드 지원
   ================================================================ */
'use strict';

// ---------------- 상수 ----------------
const WORLD_W = 1700;          // 월드 폭 (px)
const WORLD_H = 960;           // 월드 높이
const WATER_Y = WORLD_H - 46;  // 수면 y
const GRAVITY = 300;           // px/s^2
const WIND_ACCEL = 2.4;        // 바람 1당 가속도
const POWER_TO_SPEED = 7.6;    // 파워(0~100) → 초기 속도
const TURN_TIME = 30;          // 턴 제한(초)
const TANK_R = 16;             // 탱크 피격 반경

// ---------------- 탱크 타입 ----------------
const TANK_TYPES = [
  {
    id:'canny', name:'캐니', desc:'균형 잡힌 표준 캐논.\n일반탄이 든든하다.',
    hp:100, fuel:110, bodyColor:['#4aa3e8','#e85b4a'],
    normal:{ label:'캐논탄', dmg:26, radius:42, speedMul:1.0, gravMul:1.0, count:1, spread:0 },
    special:{ label:'더블샷', dmg:17, radius:30, speedMul:1.0, gravMul:1.0, count:2, spread:4, ammo:2 },
  },
  {
    id:'missos', name:'미소스', desc:'빠르고 곧게 나는 로켓.\n특수탄은 3연발!',
    hp:90, fuel:130, bodyColor:['#39b8a0','#e88f3a'],
    normal:{ label:'로켓탄', dmg:29, radius:32, speedMul:1.22, gravMul:0.88, count:1, spread:0 },
    special:{ label:'트리플', dmg:12, radius:24, speedMul:1.22, gravMul:0.88, count:3, spread:5, ammo:2 },
  },
  {
    id:'boomba', name:'붐바', desc:'느리지만 강력한 중전차.\n메가봄은 지형을 크게 판다.',
    hp:115, fuel:85, bodyColor:['#7d6ae0','#d64a7d'],
    normal:{ label:'헤비탄', dmg:31, radius:50, speedMul:0.9, gravMul:1.05, count:1, spread:0 },
    special:{ label:'메가봄', dmg:44, radius:66, speedMul:0.82, gravMul:1.1, count:1, spread:0, ammo:2 },
  },
];

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
    this.specialAmmo = this.type.special.ammo;
    this.useSpecial = false;
    this.alive = true;
    this.tilt = 0;
    this.hitFlash = 0;
    this.recoil = 0;
  }
  get color(){ return this.type.bodyColor[this.team]; }
  weapon(){ return this.useSpecial && this.specialAmmo>0 ? this.type.special : this.type.normal; }
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
  constructor(x,y,vx,vy,weapon,owner){
    this.x=x; this.y=y; this.vx=vx; this.vy=vy;
    this.weapon=weapon; this.owner=owner;
    this.dead=false; this.trail=[]; this.age=0;
  }
  step(dt, game){
    this.age+=dt;
    const sub=4, h=dt/sub;
    for(let i=0;i<sub && !this.dead;i++){
      this.vx += game.wind*WIND_ACCEL*h;
      this.vy += GRAVITY*this.weapon.gravMul*h;
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
  explode(game){ this.dead=true; game.explosionAt(this.x, this.y, this.weapon, this.owner); }
}

// ---------------- 파티클/이펙트 ----------------
class FX {
  constructor(){ this.parts=[]; this.pops=[]; this.rings=[]; this.smokes=[]; this.flashes=[]; }
  flash(x,y,a){ this.flashes.push({x,y,a,t:0}); }
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
  selP1:0, selP2:0, selStep:0,
  aiTimer:0, aiPlan:null, aiShots:0,
  banner:{text:'', t:99},
  lastImpact:null,
  turnSwitchDelay:0,

  newMatch(){
    this.terrain = new Terrain();
    this.projectiles=[]; this.fx=new FX();
    this.aiShots = 0; this.turnCount = 0;
    const x1 = rand(140, 320), x2 = rand(WORLD_W-320, WORLD_W-140);
    const t1 = new Tank(this.selP1, 0, x1, 'P1 · '+TANK_TYPES[this.selP1].name, false);
    const aiIdx = this.mode==='1p' ? Math.floor(Math.random()*TANK_TYPES.length) : this.selP2;
    const t2 = new Tank(aiIdx, 1, x2, (this.mode==='1p'?'AI · ':'P2 · ')+TANK_TYPES[aiIdx].name, this.mode==='1p');
    t1.y = this.terrain.heightAt(t1.x)-6;
    t2.y = this.terrain.heightAt(t2.x)-6;
    this.tanks=[t1,t2];
    this.current = Math.floor(Math.random()*2);
    this.wind = Math.round(rand(-6,6));   // 첫 턴은 약한 바람으로 시작
    this.state='play';
    this.lastImpact=null;
    this.startTurn(true);
    UI.enterPlay();
  },

  cur(){ return this.tanks[this.current]; },
  foe(){ return this.tanks[1-this.current]; },

  startTurn(first){
    const t=this.cur();
    if(!t.alive){ this.endMatch(); return; }
    if(!first){
      // 바람은 턴이 지날수록 범위가 넓어지고, 이전 값에서 점진적으로 변한다
      this.turnCount++;
      const cap = Math.min(28, 5 + this.turnCount*2.5);
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
    if(t.useSpecial && t.specialAmmo>0) t.specialAmmo--;
    if(t.specialAmmo<=0) t.useSpecial=false;
    const speed = Math.max(12, this.power)*POWER_TO_SPEED*w.speedMul;
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
    this.fx.pop(t.x, WATER_Y-30, '풍덩!', '#7fd4ff');
    UI.refresh();
  },

  splashAt(x){ this.fx.splash(x); Sound.splash(); },

  // ---------- AI ----------
  simulateShot(from, angleDeg, power, w){
    const a = from.barrelWorldAngle(angleDeg);
    const speed=power*POWER_TO_SPEED*w.speedMul;
    const m = from.muzzle(angleDeg);
    let x=m.x, y=m.y;
    let vx=Math.cos(a)*speed, vy=Math.sin(a)*speed;
    const h=1/60;
    for(let i=0;i<60*8;i++){
      vx+=this.wind*WIND_ACCEL*h; vy+=GRAVITY*w.gravMul*h;
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
    // 특수탄: 상대 HP 40 이하 또는 남은 탄 있고 30% 확률
    me.useSpecial = me.specialAmmo>0 && (foe.hp<=40 || Math.random()<0.3);
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
    if(this.state!=='play'){ return; }

    this.fx.update(dt);
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
    for(const t of Game.tanks) this.tank(t);
    this.projectiles();
    this.effects();
    this.water();
    this.powerGauge();
    ctx.restore();
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
    const g=ctx.createLinearGradient(0,0,0,vh);
    g.addColorStop(0,'#6fc1f2'); g.addColorStop(0.55,'#b8e4fb'); g.addColorStop(1,'#e6f7ff');
    ctx.fillStyle=g; ctx.fillRect(0,0,vw,vh);
    // 해
    ctx.save();
    ctx.globalAlpha=0.9;
    const sunX=vw*0.82, sunY=vh*0.16;
    const rg=ctx.createRadialGradient(sunX,sunY,4,sunX,sunY,60);
    rg.addColorStop(0,'#fff7ae'); rg.addColorStop(0.5,'#ffe158'); rg.addColorStop(1,'rgba(255,225,88,0)');
    ctx.fillStyle=rg; ctx.beginPath(); ctx.arc(sunX,sunY,60,0,6.283); ctx.fill();
    ctx.restore();
    // 구름 (화면 좌표 고정 비율)
    ctx.save();
    for(const c of Game.clouds){
      const x=(c.x/WORLD_W)*vw, y=c.y*vh;
      ctx.globalAlpha=0.85;
      ctx.fillStyle='#ffffff';
      const s=c.s*(vh/500);
      ctx.beginPath();
      ctx.arc(x,y,18*s,0,6.283); ctx.arc(x+20*s,y-8*s,15*s,0,6.283);
      ctx.arc(x+40*s,y,17*s,0,6.283); ctx.arc(x+20*s,y+6*s,16*s,0,6.283);
      ctx.fill();
    }
    ctx.restore();
  },

  mountains(){
    ctx.save();
    ctx.globalAlpha=0.45;
    ctx.fillStyle='#8fb8d9';
    ctx.beginPath(); ctx.moveTo(0,WORLD_H*0.55);
    for(let x=0;x<=WORLD_W;x+=60){
      ctx.lineTo(x, WORLD_H*0.42 + Math.sin(x*0.008+2)*60 + Math.sin(x*0.02)*24);
    }
    ctx.lineTo(WORLD_W,WORLD_H); ctx.lineTo(0,WORLD_H); ctx.closePath(); ctx.fill();
    ctx.restore();
  },

  terrain(){
    const g=Game.terrain.ground;
    // 흙
    const grd=ctx.createLinearGradient(0,WORLD_H*0.3,0,WORLD_H);
    grd.addColorStop(0,'#b5793c'); grd.addColorStop(0.6,'#8e5a28'); grd.addColorStop(1,'#6d411a');
    ctx.fillStyle=grd;
    ctx.beginPath(); ctx.moveTo(0,WORLD_H);
    for(let x=0;x<WORLD_W;x+=2) ctx.lineTo(x,g[x]);
    ctx.lineTo(WORLD_W,WORLD_H); ctx.closePath(); ctx.fill();
    // 흙 알갱이
    ctx.fillStyle='rgba(60,35,10,0.25)';
    for(let i=0;i<160;i++){
      const x=Math.floor(hash(i*3.7)*WORLD_W);
      const depth=hash(i*7.1)*140+18;
      const y=g[x]+depth;
      if(y<WORLD_H-8) ctx.fillRect(x,y,3,3);
    }
    // 잔디
    ctx.lineWidth=7; ctx.strokeStyle='#4fae3d'; ctx.lineJoin='round';
    ctx.beginPath();
    for(let x=0;x<WORLD_W;x+=2){ x===0?ctx.moveTo(x,g[x]-1):ctx.lineTo(x,g[x]-1); }
    ctx.stroke();
    ctx.lineWidth=3; ctx.strokeStyle='#7ed957';
    ctx.beginPath();
    for(let x=0;x<WORLD_W;x+=2){ x===0?ctx.moveTo(x,g[x]-3):ctx.lineTo(x,g[x]-3); }
    ctx.stroke();
  },

  water(){
    ctx.save();
    const t=Game.time;
    ctx.globalAlpha=0.85;
    const grd=ctx.createLinearGradient(0,WATER_Y,0,WORLD_H);
    grd.addColorStop(0,'#48a7e8'); grd.addColorStop(1,'#1e5f9e');
    ctx.fillStyle=grd;
    ctx.beginPath(); ctx.moveTo(0,WORLD_H); ctx.lineTo(0,WATER_Y);
    for(let x=0;x<=WORLD_W;x+=24) ctx.lineTo(x, WATER_Y + Math.sin(x*0.03+t*2.2)*3);
    ctx.lineTo(WORLD_W,WORLD_H); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=0.5; ctx.strokeStyle='#bfe7ff'; ctx.lineWidth=2;
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
      ctx.save();
      ctx.setLineDash([3,7]);
      ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(m.x,m.y);
      ctx.lineTo(m.x+Math.cos(a)*110, m.y+Math.sin(a)*110);
      ctx.stroke();
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
      ctx.fillStyle='#2f2f38';
      ctx.beginPath(); ctx.ellipse(0,0,7,4.5,0,0,6.283); ctx.fill();
      ctx.fillStyle='#ff8833';
      ctx.beginPath(); ctx.ellipse(-6,0,4,2.6,0,0,6.283); ctx.fill();
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
      ctx.save(); ctx.globalAlpha=0.35*(1-s.t/s.life);
      ctx.fillStyle='#9a9a9a';
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
      if(t.specialAmmo>0){ t.useSpecial=!t.useSpecial; Sound.click(); this.refresh(); }
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
      d.textContent=`${tt.desc.replace('\n',' ')} (HP ${tt.hp} · 특수 ${tt.special.label}×${tt.special.ammo})`;
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
    this.els.btnWeapon.textContent = cur.useSpecial&&cur.specialAmmo>0 ? `★${wp.label}(${cur.specialAmmo})` : wp.label;
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
