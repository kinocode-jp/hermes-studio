import { headers } from "next/headers";

export type Locale = "ja" | "en";

export async function detectLocale(): Promise<Locale> {
  const h = await headers();
  const accept = h.get("accept-language") ?? "";
  // Highest-priority language wins; treat any Japanese variant as ja.
  const first = accept.split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("ja") ? "ja" : "en";
}

type Feature = { title: string; body: string };

export type Dict = {
  metaTitle: string;
  metaDescription: string;
  navFeatures: string;
  navScreens: string;
  navStart: string;
  eyebrow: string;
  h1Before: string;
  h1Highlight: string;
  h1After: string;
  subBefore: string;
  subAfter: string;
  ctaStart: string;
  ctaScreens: string;
  note: string;
  whyBadTitle: string;
  whyBad: string[];
  whyGoodTitle: string;
  whyGood: string[];
  screensTitle: string;
  heroArtAlt: string;
  screenKanbanAlt: string;
  screenKanbanCap: string;
  screenChatAlt: string;
  screenChatCap: string;
  featuresTitle: string;
  features: Feature[];
  startTitle: string;
  startBody: string;
  footDisclaimer: string;
  footLicense: string;
  spriteNames: string[];
};

const ja: Dict = {
  metaTitle: "Hermes Studio — 強力な Hermes エージェントを、誰でもカンタンに",
  metaDescription:
    "ターミナル操作なしで、強力な Hermes Agent をだれでも直感的に。エージェントはピクセルオフィスのキャラクターとして現れ、チャット・カンバン・チーム設定をクリックひとつで扱えます。",
  navFeatures: "機能",
  navScreens: "スクリーンショット",
  navStart: "はじめる",
  eyebrow: "実験的・コミュニティプロジェクト",
  h1Before: "強力な Hermes エージェントを、",
  h1Highlight: "誰でもカンタンに",
  h1After: "。",
  subBefore: "",
  subAfter:
    " は強力ですが、ターミナルと設定ファイルの世界。Hermes Studio はそれをピクセルオフィスのビジュアルUIに変えます。エージェントはオフィスで働くキャラクターとして現れ、チャット・設定・カンバンのタスクをクリックひとつで開けます。コマンドを覚える必要はありません。",
  ctaStart: "はじめる →",
  ctaScreens: "画面を見る",
  note: "非公式の独立プロジェクトです。Nous Research の公式プロダクトではありません。",
  whyBadTitle: "これまで",
  whyBad: [
    "ターミナルでセッションを起動・切替",
    "タスクの状況はログを追って把握",
    "複数エージェントの並行作業が見えない",
  ],
  whyGoodTitle: "Hermes Studio なら",
  whyGood: [
    "キャラクターをクリックして会話を開始",
    "カンバンで担当・状態・コメントがひと目でわかる",
    "最大4つのチャットを並べて同時に進行",
  ],
  screensTitle: "実際の画面",
  heroArtAlt: "Hermes Studio のピクセルキャラクターたち — チャット・カンバン・チーム・タスクを担当",
  screenKanbanAlt:
    "Hermes Studio のタスクボード画面。ステータス列で並んだカンバンと、左のプロファイルロスター",
  screenKanbanCap: "タスクボード — 担当 Profile・状態・コメントをライブに反映",
  screenChatAlt: "Hermes Studio の会話ペインをタスクボードの横にドッキングした画面",
  screenChatCap: "会話ペイン — タスクボードの横にドッキングして最大4つ並べる",
  featuresTitle: "機能",
  features: [
    {
      title: "ピクセルオフィス・ロスター",
      body:
        "すべての Hermes Profile がアニメーションするオフィスキャラクターに。前/横/後ろの歩行フレーム、カスタムポートレート、安定したデスク配置。7体目以降は決定的な色相バリアントで自動生成されます。",
    },
    {
      title: "マルチペイン・チャット",
      body:
        "最大4つの会話を同時に並べて表示。ストリーミング、ステアリング、割り込み、再接続、正規化されたツールイベントに対応し、会話をドラッグして好きな位置に配置できます。",
    },
    {
      title: "Hermes カンバン",
      body:
        "タスクボードの閲覧と更新、Profile への割り当て、コメント、ライブ更新。タスクケーブルがオフィスの床を走り、誰が何をしているかがひと目でわかります。",
    },
    {
      title: "オフィスチーム",
      body:
        "Hermes Profile を多対多でグルーピング。ロスターバッジ、カンバン由来のチームワークロード表示、チームでのタスク絞り込みに対応します。",
    },
    {
      title: "Skills・SOUL・Memory 設定",
      body:
        "Profile 単位でインストール済み Skills、SOUL、Memory プロバイダー設定を管理。Office 全体の共有コンテキスト層と明示的な継承同期も備えています。",
    },
    {
      title: "日英UI・PWA",
      body:
        "英語/日本語UI、文字サイズ調整、ライト/ダークテーマ、スマートフォン向けレスポンシブナビゲーション、インストール可能な PWA シェル。",
    },
  ],
  startTitle: "はじめる",
  startBody:
    "現在はソースビルド専用(pre-1.0)です。Node.js 22.x と Hermes Agent が同一OSユーザーにインストールされている必要があります。公開インターネットへ直接公開しないでください。",
  footDisclaimer:
    "Hermes Studio は独立したコミュニティプロジェクトであり、Nous Research とは無関係です。公式 Hermes Agent インターフェースを置き換えるものではありません。",
  footLicense: "MIT License",
  spriteNames: ["受付", "フーディン", "カメックス", "ラッキー", "リザードン", "ピッピ"],
};

const en: Dict = {
  metaTitle: "Hermes Studio — Powerful Hermes agents, made easy for everyone",
  metaDescription:
    "No terminal required. Hermes Studio turns the powerful Hermes Agent into a visual pixel office: agents appear as characters, and chat, Kanban, and team settings are one click away.",
  navFeatures: "Features",
  navScreens: "Screenshots",
  navStart: "Get started",
  eyebrow: "Experimental community project",
  h1Before: "Powerful Hermes agents, ",
  h1Highlight: "easy for everyone",
  h1After: ".",
  subBefore: "",
  subAfter:
    " is powerful — but it lives in terminals and config files. Hermes Studio turns it into a pixel-office visual UI. Agents appear as characters working in an office, and chats, settings, and Kanban tasks open with a single click. No commands to memorize.",
  ctaStart: "Get started →",
  ctaScreens: "See it in action",
  note: "An unofficial, independent project. Not an official Nous Research product.",
  whyBadTitle: "Before",
  whyBad: [
    "Launch and switch sessions in a terminal",
    "Track task progress by reading logs",
    "No visibility into agents working in parallel",
  ],
  whyGoodTitle: "With Hermes Studio",
  whyGood: [
    "Click a character to start a conversation",
    "Kanban shows assignee, status, and comments at a glance",
    "Run up to four chats side by side",
  ],
  screensTitle: "Real screens",
  heroArtAlt: "Hermes Studio pixel characters handling chat, Kanban, teams, and tasks",
  screenKanbanAlt:
    "Hermes Studio task board with status columns and the profile roster on the left",
  screenKanbanCap: "Task board — assignees, status, and comments update live",
  screenChatAlt: "Hermes Studio chat pane docked next to the task board",
  screenChatCap: "Chat panes — dock up to four next to the task board",
  featuresTitle: "Features",
  features: [
    {
      title: "Pixel Office Roster",
      body:
        "Every Hermes Profile becomes an animated office character with front/side/back walking frames, custom portraits, and stable desk slots. Profiles seven and up get deterministic hue variants.",
    },
    {
      title: "Multi-pane Chat",
      body:
        "Up to four simultaneous conversations with streaming, steering, interruption, reconnect, and normalized tool events. Drag conversations to arrange them however you like.",
    },
    {
      title: "Hermes Kanban",
      body:
        "View and update the task board, assign Profiles, comment, and get live refresh. Task cables run across the office floor so you can see who is doing what.",
    },
    {
      title: "Office Teams",
      body:
        "Group Hermes Profiles many-to-many, with roster badges, Kanban-derived team workload, and team task filtering.",
    },
    {
      title: "Skills, SOUL & Memory",
      body:
        "Manage installed Skills, SOUL, and Memory provider settings per Profile, plus an Office-wide shared-context layer with explicit inheritance sync.",
    },
    {
      title: "EN/JA UI & PWA",
      body:
        "English/Japanese UI, adjustable text size, light/dark themes, responsive phone navigation, and an installable PWA shell.",
    },
  ],
  startTitle: "Get started",
  startBody:
    "Source builds only for now (pre-1.0). Node.js 22.x and Hermes Agent must be installed for the same OS user. Do not expose it directly to the public internet.",
  footDisclaimer:
    "Hermes Studio is an independent community project, not affiliated with Nous Research, and does not replace the official Hermes Agent interface.",
  footLicense: "MIT License",
  spriteNames: ["Reception", "Alakazam", "Blastoise", "Chansey", "Charizard", "Clefairy"],
};

export function getDict(locale: Locale): Dict {
  return locale === "ja" ? ja : en;
}
