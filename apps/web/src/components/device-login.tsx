import { useEffect, useRef, useState } from "preact/hooks";
import { authenticateRemoteDevice } from "../office-api";
import { locale, localizeRuntimeMessage, setLocale, t } from "../i18n";
import { InfoTip } from "./info-tip";
import {
  officeAccess,
  retryStudioServer,
  setDeviceLoginFailure,
  setDeviceLoginSubmitting
} from "../store";
import { classifyDeviceLoginFailure, shouldShowDeviceEnrollmentForm } from "../auth-state";

/* ── WebGL bright-lab shader ── */
const VERT = `attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0,1);}`;
const FRAG = `
precision mediump float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_connect;
uniform float u_error;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p*=2.1;a*=.5;}return v;}

void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  vec2 p=(gl_FragCoord.xy-.5*u_res)/u_res.y;
  float t=u_time*.08*(1.+u_connect*.6);

  float n1=fbm(p*2.5+t*vec2(.7,.3));
  float n2=fbm(p*3.0-t*vec2(.4,.6)+3.7);
  float n3=fbm(p*1.8+t*vec2(-.3,.5)+7.1);

  vec3 c1=vec3(.965,.975,.985);
  vec3 c2=vec3(.86,.945,.925);
  vec3 c3=vec3(.90,.94,.98);
  vec3 c4=vec3(.98,.90,.88);

  vec3 col=mix(c1,c2,smoothstep(.3,.7,n1));
  col=mix(col,c3,smoothstep(.4,.8,n2)*.6);
  col=mix(col,c4,u_error*smoothstep(.3,.6,n3)*.6);
  col-=vec3(.02,.05,.045)*u_connect*n1;

  float vig=1.-dot(p*.8,p*.8);
  vig=smoothstep(0.,.9,vig);
  col=mix(col*.94,col,vig);

  vec2 grid=abs(fract(p*8.)-.5);
  float line=min(grid.x,grid.y);
  float gridAlpha=smoothstep(.0,.02,line);
  col=mix(col-vec3(.03,.05,.05),col,gridAlpha);

  float spot=smoothstep(.62,.65,n1*n2)*.12;
  col-=vec3(.05,.10,.09)*spot;

  float scan=smoothstep(.003,0.,abs(fract(uv.y-t*2.)-.5)-.498);
  col-=vec3(.04,.07,.06)*scan*.3;

  gl_FragColor=vec4(col,1);
}`;

function initWebGL(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null;

  function compile(type: number, src: string) {
    const s = gl!.createShader(type)!;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    return s;
  }

  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  return {
    gl,
    uTime: gl.getUniformLocation(prog, "u_time"),
    uRes: gl.getUniformLocation(prog, "u_res"),
    uConnect: gl.getUniformLocation(prog, "u_connect"),
    uError: gl.getUniformLocation(prog, "u_error"),
  };
}

export function DeviceLogin() {
  const access = officeAccess.value;
  const [retrySeconds, setRetrySeconds] = useState(access.retryAfterSeconds ?? 0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const startRef = useRef(performance.now());
  const stateRef = useRef({ connect: 0, error: 0 });

  const checking = access.state === "checking";
  const submitting = access.state === "submitting";
  const isError = !!access.failureCode;

  // Keep ref in sync for the render loop
  stateRef.current.connect = (checking || submitting) ? 1 : 0;
  stateRef.current.error = isError ? 1 : 0;

  useEffect(() => {
    setRetrySeconds(access.retryAfterSeconds ?? 0);
  }, [access.retryAfterSeconds]);

  useEffect(() => {
    if (retrySeconds <= 0) return;
    const timer = window.setTimeout(() => setRetrySeconds((v) => Math.max(0, v - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [retrySeconds]);

  // WebGL render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = initWebGL(canvas);
    if (!ctx) return;

    function resize() {
      const dpr = Math.min(devicePixelRatio, 2);
      canvas!.width = canvas!.clientWidth * dpr;
      canvas!.height = canvas!.clientHeight * dpr;
      ctx!.gl.viewport(0, 0, canvas!.width, canvas!.height);
    }
    resize();
    window.addEventListener("resize", resize);

    function frame() {
      if (!ctx) return;
      const elapsed = (performance.now() - startRef.current) / 1000;
      const { gl, uTime, uRes, uConnect, uError } = ctx;
      gl.uniform1f(uTime, elapsed);
      gl.uniform2f(uRes, canvas!.width, canvas!.height);
      gl.uniform1f(uConnect, stateRef.current.connect);
      gl.uniform1f(uError, stateRef.current.error);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frameRef.current = requestAnimationFrame(frame);
    }
    frame();

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (access.state === "submitting" || retrySeconds > 0) return;
    const form = event.currentTarget as HTMLFormElement;
    const deviceNameInput = form.elements.namedItem("device-name") as HTMLInputElement;
    const credentialInput = form.elements.namedItem("access-token") as HTMLInputElement;

    setDeviceLoginSubmitting();
    const login = authenticateRemoteDevice(deviceNameInput.value, credentialInput.value, access.serverUrl);
    credentialInput.value = "";
    try {
      const result = await login;
      if (result.ok) retryStudioServer();
      else setDeviceLoginFailure(result);
    } catch {
      setDeviceLoginFailure(classifyDeviceLoginFailure(0, null));
    }
  };

  return (
    <main class={`dl-shell ${checking || submitting ? "is-connecting" : ""} ${isError ? "is-error" : ""}`}>
      {/* WebGL nebula background */}
      <canvas ref={canvasRef} class="dl-bg" aria-hidden="true" />

      {/* Overlay layers */}
      <div class="dl-vignette" aria-hidden="true" />
      <div class="dl-scanline" aria-hidden="true" />

      {/* Language toggle */}
      <button
        class="dl-lang"
        type="button"
        aria-label={t("language.label")}
        title={t("language.label")}
        onClick={() => setLocale(locale.value === "ja" ? "en" : "ja")}
      >
        <span aria-hidden="true">{locale.value === "ja" ? "A" : "文"}</span>
      </button>

      {/* Content */}
      <div class="dl-content">
        {/* Orbital mark — CSS rings */}
        <div class="dl-mark" aria-hidden="true">
          <div class="dl-mark-ring dl-mark-ring--outer" />
          <div class="dl-mark-ring dl-mark-ring--mid" />
          <div class="dl-mark-ring dl-mark-ring--inner" />
          <div class="dl-mark-core" />
          <div class="dl-mark-glow" />
        </div>

        <div class="dl-text">
          <p class="dl-kicker">HERMES STUDIO</p>
          <h1 id="device-login-title" class="dl-title">
            {checking
              ? <span class="dl-title-connecting">{t("login.connecting")}<span class="dl-dots"><span>.</span><span>.</span><span>.</span></span></span>
              : t("login.title")}
          </h1>
          <p class={`dl-status ${checking || submitting ? "is-busy" : ""} ${isError ? "is-error" : ""}`} role={isError ? "alert" : "status"}>
            {localizeRuntimeMessage(access.message)}
          </p>
        </div>

        {shouldShowDeviceEnrollmentForm(access.state) && (
          <form class="dl-form" autoComplete="off" onSubmit={submit}>
            <div class="dl-field">
              <label for="dl-device-name">{t("login.deviceName")}</label>
              <input id="dl-device-name" name="device-name" type="text" defaultValue="My device" minLength={1} maxLength={64} autoComplete="off" required />
            </div>
            <div class="dl-field">
              <label for="dl-token">{t("login.token")} <InfoTip text={t("login.tokenNote")} align="start" /></label>
              <input id="dl-token" name="access-token" type="password" minLength={1} maxLength={4096} autoComplete="off" autoCapitalize="none" spellcheck={false} required />
            </div>
            <button type="submit" class="dl-submit" disabled={submitting || retrySeconds > 0}>
              {submitting ? t("login.authenticating") : retrySeconds > 0 ? t("login.retryAfter", { seconds: retrySeconds }) : t("login.authenticate")}
            </button>
          </form>
        )}

        {access.state === "unavailable" && (
          <button class="dl-retry" type="button" onClick={retryStudioServer}>
            <span class="dl-retry-icon">↻</span>
            {t("login.reconnect")}
          </button>
        )}
      </div>
    </main>
  );
}
