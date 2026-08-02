import type { OfficeTeam } from "@hermes-studio/protocol";
import type { ChatSession, Profile, TaskComment, WorkTask } from "./domain";

export const profiles: Profile[] = [
  {
    id: "researcher",
    name: "Mina",
    displayName: "ミナ",
    role: "Research",
    status: "working",
    color: "#64b7a7",
    sessions: 2,
    taskCount: 3,
    memoryBytes: 1842,
    memoryNote: "一次情報を優先し、調査結果には出典と確度を付ける。",
    skills: ["source-review", "market-map"],
    inheritedSkills: ["web-search", "document-reader"]
  },
  {
    id: "builder",
    name: "Theo",
    displayName: "テオ",
    role: "Engineering",
    status: "waiting",
    color: "#e07a55",
    sessions: 3,
    taskCount: 2,
    memoryBytes: 1270,
    memoryNote: "変更は小さく保ち、型境界と失敗時の挙動を先に固める。",
    skills: ["typescript", "release-check"],
    inheritedSkills: ["git", "terminal"]
  },
  {
    id: "operator",
    name: "Iris",
    displayName: "アイリス",
    role: "Operations",
    status: "blocked",
    color: "#d6a94f",
    sessions: 1,
    taskCount: 4,
    memoryBytes: 2031,
    memoryNote: "外部操作は必ず確認を挟み、復旧手順を作業記録へ残す。",
    skills: ["inbox-triage", "incident-notes"],
    inheritedSkills: ["calendar", "kanban"]
  },
  {
    id: "editor",
    name: "Ren",
    displayName: "レン",
    role: "Editorial",
    status: "idle",
    color: "#8499c8",
    sessions: 1,
    taskCount: 1,
    memoryBytes: 988,
    memoryNote: "簡潔な日本語を使い、固有名詞と数値は公開前に再確認する。",
    skills: ["tone-guide", "fact-check"],
    inheritedSkills: ["document-reader"]
  }
];

export const initialSessions: ChatSession[] = [
  {
    id: "s-research-1",
    profileId: "researcher",
    title: "Hermes API調査",
    status: "streaming",
    messages: [
      { id: "m1", from: "user", body: "公式APIで安定して使える境界を整理して。", at: "10:21" },
      { id: "m2", from: "agent", body: "Profile、Session、Kanbanを分けて確認しています。まずserveの接続契約を固定します。", at: "10:22" },
      { id: "m3", from: "tool", body: "Reading developer guide / desktop backend", at: "10:22" }
    ]
  },
  {
    id: "s-build-1",
    profileId: "builder",
    title: "Studio UI",
    status: "waiting",
    messages: [
      { id: "m4", from: "user", body: "Profileをキャラクターとして扱って。", at: "10:08" },
      { id: "m5", from: "agent", body: "各キャラクターに複数Sessionを束ねました。レイアウト確認を待っています。", at: "10:11" }
    ]
  },
  {
    id: "s-build-2",
    profileId: "builder",
    title: "PWA shell",
    status: "ready",
    messages: [{ id: "m6", from: "agent", body: "Installable shell is ready for review.", at: "09:48" }]
  }
];

export const initialTasks: WorkTask[] = [
  { id: "t-104", title: "serve接続契約を固定", status: "running", assigneeId: "researcher", priority: "high", comments: 3 },
  { id: "t-105", title: "Profile継承モデル", status: "ready", assigneeId: "builder", priority: "normal", comments: 1 },
  { id: "t-106", title: "Remote auth threat model", status: "blocked", assigneeId: "operator", priority: "high", comments: 4 },
  { id: "t-107", title: "Mobile chat navigation", status: "triage", priority: "normal", comments: 0 },
  { id: "t-108", title: "Skill provenance labels", status: "ready", assigneeId: "editor", priority: "normal", comments: 2 },
  { id: "t-102", title: "Studio state reducer", status: "done", assigneeId: "builder", priority: "normal", comments: 2 }
];

/** Sample Studio teams for explicit demo mode (not persisted). */
export const initialTeams: OfficeTeam[] = [
  {
    id: "team-000000000000000000000001",
    name: "Core Product",
    color: "#64b7a7",
    description: "Research and engineering pairing for product work.",
    leadProfileId: "researcher",
    memberProfileIds: ["researcher", "builder"],
    settings: {
      revision: 0,
      skillsEnabled: true,
      contextEnabled: true,
      skills: ["research", "browser"],
      context: "Core product team: prefer verified sources and ship small diffs.",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    revision: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "team-000000000000000000000002",
    name: "Ops & Editorial",
    color: "#d6a94f",
    description: "Incidents, release notes, and operator review.",
    leadProfileId: "operator",
    memberProfileIds: ["operator", "editor"],
    settings: {
      revision: 0,
      skillsEnabled: true,
      contextEnabled: true,
      skills: [],
      context: "",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    revision: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
];

export const initialTaskComments: TaskComment[] = [
  { id: 1, cardId: "t-104", author: "Mina", body: "serve の起動・再接続・終了の境界を先に整理しました。", createdAt: 1_752_652_100 },
  { id: 2, cardId: "t-104", author: "Theo", body: "WebSocket の再接続時に履歴を先に同期する設計で確認します。", createdAt: 1_752_655_200 },
  { id: 3, cardId: "t-104", author: "Mina", body: "公式APIで保証される項目に絞って文書化中です。", createdAt: 1_752_659_400 },
  { id: 4, cardId: "t-105", author: "Theo", body: "グローバル設定とProfile固有設定の優先順位をテストします。", createdAt: 1_752_661_000 },
  { id: 5, cardId: "t-106", author: "Iris", body: "外部公開時は認証なしのアクセスを許可しません。", createdAt: 1_752_664_000 },
  { id: 6, cardId: "t-106", author: "Mina", body: "Tailnet と公開プロキシを別の脅威モデルとして扱います。", createdAt: 1_752_665_800 },
  { id: 7, cardId: "t-106", author: "Iris", body: "端末の失効と監査ログの確認手順を追加しました。", createdAt: 1_752_668_300 },
  { id: 8, cardId: "t-106", author: "Ren", body: "利用者向けの注意書きを短く整理します。", createdAt: 1_752_670_100 },
  { id: 9, cardId: "t-108", author: "Ren", body: "継承元が分かるラベル案を用意しました。", createdAt: 1_752_672_500 },
  { id: 10, cardId: "t-108", author: "Mina", body: "Profile固有スキルとの見分けやすさを確認します。", createdAt: 1_752_674_200 },
  { id: 11, cardId: "t-102", author: "Theo", body: "接続状態と表示状態を分離しました。", createdAt: 1_752_677_000 },
  { id: 12, cardId: "t-102", author: "Iris", body: "エラー復旧後も選択中のProfileを保持できています。", createdAt: 1_752_680_000 }
];
