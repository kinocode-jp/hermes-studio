import { detectLocale, getDict } from "./i18n";

const SPRITE_IDS = ["default", "alakazam", "blastoise", "chansey", "charizard", "clefairy"];

function Sprite({ row, size = 72 }: { row: number; size?: number }) {
  return (
    <span
      aria-hidden
      className="sprite"
      style={{
        width: size,
        height: size,
        backgroundPosition: `0% ${(row / 5) * 100}%`,
      }}
    />
  );
}

export default async function Home() {
  const locale = await detectLocale();
  const t = getDict(locale);
  return (
    <main className="page">
      <header className="nav">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/lp/icon.png" alt="Hermes Studio" width={36} height={36} />
          <span>
            Hermes <em>Studio</em>
          </span>
        </div>
        <nav className="navlinks" aria-label="in-page links">
          <a href="#features">{t.navFeatures}</a>
          <a href="#screens">{t.navScreens}</a>
          <a href="#start">{t.navStart}</a>
        </nav>
        <a
          className="pill"
          href="https://github.com/kinocode-jp/hermes-studio"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">{t.eyebrow}</span>
          <h1>
            {t.h1Before}
            <span className="hl">{t.h1Highlight}</span>
            {t.h1After}
          </h1>
          <p className="sub">
            <a href="https://github.com/NousResearch/hermes-agent" target="_blank" rel="noreferrer">
              Hermes Agent
            </a>
            {t.subAfter}
          </p>
          <div className="cta-row">
            <a className="cta" href="#start">
              {t.ctaStart}
            </a>
            <a className="cta ghost" href="#screens">
              {t.ctaScreens}
            </a>
          </div>
          <p className="note">{t.note}</p>
        </div>
        <div className="hero-art">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/lp/hero-characters.png" alt={t.heroArtAlt} />
        </div>
      </section>

      <section className="why">
        <div className="why-inner">
          <div className="why-col bad">
            <h3>{t.whyBadTitle}</h3>
            <ul>
              {t.whyBad.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="why-arrow" aria-hidden>
            →
          </div>
          <div className="why-col good">
            <h3>{t.whyGoodTitle}</h3>
            <ul>
              {t.whyGood.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="screens" id="screens">
        <h2>{t.screensTitle}</h2>
        <div className="shots">
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/lp/screen-kanban.png" alt={t.screenKanbanAlt} />
            <figcaption>{t.screenKanbanCap}</figcaption>
          </figure>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/lp/screen-chat.png" alt={t.screenChatAlt} />
            <figcaption>{t.screenChatCap}</figcaption>
          </figure>
        </div>
      </section>

      <section className="features" id="features">
        <h2>{t.featuresTitle}</h2>
        <div className="grid">
          {t.features.map((f) => (
            <article className="card" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="start" id="start">
        <div className="start-inner">
          <div>
            <h2>{t.startTitle}</h2>
            <p>{t.startBody}</p>
          </div>
          <pre aria-label="setup commands">
            <code>{`git clone https://github.com/kinocode-jp/hermes-studio
cd hermes-studio
npm install
npm run dev`}</code>
          </pre>
        </div>
        <div className="start-row" aria-hidden>
          {SPRITE_IDS.map((id, i) => (
            <Sprite key={id} row={i} size={48} />
          ))}
        </div>
      </section>

      <footer className="foot">
        <p>{t.footDisclaimer}</p>
        <p>{t.footLicense}</p>
      </footer>
    </main>
  );
}
