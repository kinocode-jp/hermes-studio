import type {
  OfficeSnapshot,
  ProtocolVersion,
  RuntimeStatus,
} from "@hermes-studio/protocol";

export const STUDIO_SERVER_PROTOCOL_VERSION: ProtocolVersion = 1;

const runtime: RuntimeStatus = {
  mode: "existing-local",
  state: "unconfigured",
  adapterVersion: "0.1.0-demo",
  compatibilityMessage: "Connect a local Hermes runtime to replace demo state.",
};

/**
 * Returns a fresh, explicit read model. Do not spread runtime configuration or
 * process environment values into API responses.
 */
export function createDemoSnapshot(now = new Date()): OfficeSnapshot {
  const timestamp = now.toISOString();

  return {
    generatedAt: timestamp,
    sequence: 0,
    capabilities: {
      protocolVersion: STUDIO_SERVER_PROTOCOL_VERSION,
      serverVersion: "0.1.0",
      runtime: { ...runtime },
      access: {
        deviceId: "local-demo-device",
        tier: "viewer",
        exposure: "loopback",
        authentication: "desktop-capability",
        allowedOperations: ["state.read"],
      },
      features: [
        "chat",
        "profiles",
        "skills",
        "memory",
        "kanban",
        "teams",
        "global-inheritance",
        "demo",
      ],
    },
    globalSettings: {
      sharedContextEnabled: true,
      sharedSkillsEnabled: true,
      revision: 1,
    },
    profiles: [
      {
        id: "profile-researcher",
        name: "Researcher",
        avatarKey: "researcher",
        activity: "idle",
        activeSessionCount: 1,
        inheritedSkillCount: 3,
        ownSkillCount: 1,
        revision: 1,
      },
      {
        id: "profile-builder",
        name: "Builder",
        avatarKey: "builder",
        activity: "offline",
        activeSessionCount: 0,
        inheritedSkillCount: 3,
        ownSkillCount: 2,
        revision: 1,
      },
    ],
    sessions: [
      {
        id: "session-welcome",
        profileId: "profile-researcher",
        title: "Welcome to Hermes Studio",
        activity: "idle",
        createdAt: timestamp,
        updatedAt: timestamp,
        lastMessagePreview: "Connect Hermes to begin a live session.",
      },
    ],
    inventory: {
      profiles: { returned: 2, available: 2, total: 2, hasMore: false, truncated: false, partialFailures: 0 },
      sessions: { returned: 1, available: 1, total: 1, hasMore: false, truncated: false, partialFailures: 0 },
    },
    boards: [
      {
        id: "board-main",
        name: "Office tasks",
        cardCount: 0,
        revision: 1,
      },
    ],
  };
}

export function createDemoRuntimeStatus(): RuntimeStatus {
  return { ...runtime };
}
