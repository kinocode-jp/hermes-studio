import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ApprovalChoice, ChatMessage, ChatOperationEvidence, ChatPendingInteraction, ChatSession, Profile } from "../domain";
import { chatMessageBody, chatSessionTitle, locale, localizeRuntimeMessage, officeRuntimeMessage, t, type TranslationKey } from "../i18n";
import { MarkdownBody } from "./markdown";
import {
  activeSessionId,
  clearFollowUpSuggestions,
  closeSession,
  cancelSessionModelChange,
  consumeCardSeed,
  consumeChatComposerPrefill,
  pendingCardSeedForPrompt,
  interruptSession,
  officeSnapshot,
  openSession,
  reconnectChatSession,
  respondToApproval,
  respondToClarification,
  sendMessage,
  steerSession,
  profileList,
} from "../store";
import { canSteerChatSession, canSubmitChatPrompt, composerBlockedReason, isChatRunActive } from "../session-runtime";
import { isStudioSlashCommand, slashCatalogVersion, slashSuggestionsFor } from "../slash-commands";
import { displayProfileReferences, profileDisplayName } from "../profile-names";
import {
  appendAttachments,
  buildPromptWithAttachments,
  fileToAttachment,
  type ChatAttachment,
} from "../chat-attachments";
import {
  chatComposerState as sessionChatComposerState,
  clearAcknowledgedChatComposer,
  setChatComposerAttachments,
  setChatComposerDraft,
} from "../chat-composer-state";
import {
  chatModelPresets,
  matchingChatModelPresetName,
} from "../chat-model-prefs";
import { buildCardSeededUserPrompt, sessionNeedsCardSeed } from "../kanban-ask";
import { ChatModelPanel } from "./chat-model-panel";
import { ComposerModelPickers } from "./composer-model-pickers";
import { AttachIcon, CloseIcon, CopyIcon, MenuIcon, MicIcon, SendIcon, SteerIcon, StopIcon } from "./icons";
import {
  setWorkspacePlacement,
  workspacePlacement,
  type WorkspacePlacement,
} from "../workspace-layout";

export function ChatPane({
  session,
  profile,
  onClosePane,
  hideHeader = false,
  activateWorkspaceOnPointerDown = false,
}: {
  session: ChatSession;
  profile: Profile;
  onClosePane?: () => void;
  hideHeader?: boolean;
  /** Only panes already owned by the workspace/dashboard may activate it. */
  activateWorkspaceOnPointerDown?: boolean;
}) {
  const composer = sessionChatComposerState(session.id);
  const { draft, attachments } = composer.value;
  const setDraft = (next: string | ((current: string) => string)) => setChatComposerDraft(session.id, next);
  const setAttachments = (next: ChatAttachment[] | ((current: ChatAttachment[]) => ChatAttachment[])) => setChatComposerAttachments(session.id, next);
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const [modelNote, setModelNote] = useState<string | undefined>(undefined);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelProviderHint, setModelProviderHint] = useState<string | undefined>(undefined);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(-1);
  const voiceRecognitionRef = useRef<any>(null);
  const [announcedOperation, setAnnouncedOperation] = useState<ChatOperationEvidence | undefined>(undefined);
  const [expandedLogGroups, setExpandedLogGroups] = useState<Set<string>>(() => new Set());
  const announcedOperationKey = useRef("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerMenuRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottom = useRef(true);
  const isActive = activeSessionId.value === session.id;
  const isLiveChat = session.remoteKind === "stored" || session.remoteKind === "draft";
  const isConnected = !isLiveChat || session.connectionState === "ready";
  const { canCompose, canSteer, runActive, showStop } = chatComposerState(session);
  const canSend = canSubmitChatPrompt(session);
  const blocked = composerBlockedReason(session);
  const transcript = session.messages.filter((message) => message.promptOperation === undefined && message.kind !== "steer");
  const operationEvidence = presentedOperationEvidence(session);
  const timeline = groupChatTimeline(buildChatTimeline(transcript, operationEvidence));
  const displayTitle = chatSessionTitle(session);
  const profileName = profileDisplayName(profile);
  const waitingForCardQuestion = sessionNeedsCardSeed(session);
  const composerPlaceholder = session.pendingInteraction ? t("chat.answerAbove")
    : !isConnected ? t("chat.connectingPlaceholder")
      : runActive ? t("chat.steerPlaceholder")
        : waitingForCardQuestion ? t("kanban.askSeed.placeholder")
          : t("chat.instruct", { name: profileName });
  const slashCatalogGeneration = slashCatalogVersion();
  const slashSuggestions = useMemo(() => {
    if (session.remoteKind === "demo" || slashDismissed) return [];
    return slashSuggestionsFor(draft);
  }, [draft, session.remoteKind, slashDismissed, slashCatalogGeneration]);
  useEffect(() => {
    // A new prefix reopens the menu after Esc and resets the highlight.
    setSlashDismissed(false);
    setSlashIndex(-1);
  }, [draft]);
  useEffect(() => {
    const prefill = session.composerPrefill;
    if (!prefill) return;
    setDraft(prefill.text);
    consumeChatComposerPrefill(session.id, prefill.id);
  }, [session.composerPrefill?.id, session.id]);
  const statusText = useMemo(() => {
    if (session.connectionState === "error") return t("chat.status.error");
    if (session.connectionState === "queued") return t("chat.status.queued");
    if (session.connectionState === "connecting") return t("chat.status.connecting");
    if (session.connectionState === "disconnected" && isLiveChat) return t("chat.status.reconnecting");
    if (session.historyState === "loading") return t("chat.status.loading");
    if (session.interruptPending) return t("chat.status.stopping");
    if (session.slashPending) return t("chat.status.running");
    if (session.pendingInteraction?.kind === "approval") return t("chat.status.approval");
    if (session.pendingInteraction?.kind === "clarify") return t("chat.status.clarify");
    if (session.status === "waiting") return t("chat.status.waiting");
    if (runActive) return t("chat.status.running");
    return t("chat.status.ready");
  }, [isLiveChat, locale.value, runActive, session.connectionState, session.historyState, session.interruptPending, session.pendingInteraction?.kind, session.slashPending, session.status]);
  const suggestions = session.followUpSuggestions ?? [];
  const hasSendable = Boolean(draft.trim() || attachments.length > 0);
  const submitDisabled = (runActive ? !canSteer : !canSend) || !hasSendable;
  const presetReadout = matchingChatModelPresetName(chatModelPresets.value, {
    provider: session.provider ?? "",
    model: session.model ?? "",
    reasoningEffort: session.reasoningEffort ?? "",
  });

  useEffect(() => {
    const list = messageListRef.current;
    if (list && shouldStickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [session.messages.length, session.messages.at(-1)?.body, operationEvidence.length, operationEvidence.at(-1)?.state, session.pendingInteraction?.id, suggestions.length]);

  useEffect(() => {
    const next = nextOperationAnnouncement(operationEvidence, announcedOperationKey.current);
    if (!next) return;
    announcedOperationKey.current = next.key;
    setAnnouncedOperation(next.operation);
  }, [operationEvidence.at(-1)?.id, operationEvidence.at(-1)?.state, operationEvidence.at(-1)?.message]);

  useEffect(() => {
    if (!composerMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && composerMenuRef.current?.contains(target)) return;
      setComposerMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setComposerMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [composerMenuOpen]);

  async function addFiles(fileList: FileList | null): Promise<void> {
    if (!fileList?.length) return;
    setAttachError(undefined);
    const next: ChatAttachment[] = [];
    for (const file of Array.from(fileList)) {
      try {
        const result = await fileToAttachment(file);
        if ("error" in result) {
          setAttachError(t(`chat.attachError.${result.error}` as TranslationKey));
          continue;
        }
        next.push(result);
      } catch {
        setAttachError(t("chat.attachError.read-failed"));
      }
    }
    if (next.length > 0) {
      setAttachments((current) => {
        const merged = appendAttachments(current, next);
        if (merged.truncated > 0) setAttachError(t("chat.attachError.too-many", { count: merged.truncated }));
        return merged.attachments;
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    const submittedComposer = composer.value;
    const submittedAttachError = attachError;
    const prompt = buildPromptWithAttachments(submittedComposer.draft, submittedComposer.attachments);
    if (typeof prompt !== "string") {
      setAttachError(t("chat.attachError.payload-too-large"));
      return;
    }
    if (!prompt.trim()) return;
    if (runActive) {
      if (await steerSession(session.id, prompt)) {
        if (clearAcknowledgedChatComposer(session.id, submittedComposer)) {
          setAttachError((current) => current === submittedAttachError ? undefined : current);
        }
      }
      return;
    }
    if (!canSend) return;
    // For "Ask assignee", attach card context once to the user's first typed prompt.
    const cardContext = pendingCardSeedForPrompt(session.id);
    // Slash commands are control-plane operations, not the first card question.
    // Route the untouched command through sendMessage so it reaches slash.exec,
    // and retain the one-shot card context for the first real user prompt.
    const seededCardContext = cardContext && !isStudioSlashCommand(prompt) ? cardContext : undefined;
    const outbound = seededCardContext ? buildCardSeededUserPrompt(seededCardContext, prompt) : prompt;
    if (typeof outbound !== "string") {
      setAttachError(t("chat.attachError.payload-too-large"));
      return;
    }
    const sent = await sendMessage(session.id, outbound);
    if (!sent) return;
    if (seededCardContext) consumeCardSeed(session.id, seededCardContext);
    if (clearAcknowledgedChatComposer(session.id, submittedComposer)) {
      setAttachError((current) => current === submittedAttachError ? undefined : current);
    }
    clearFollowUpSuggestions(session.id);
  }

  function applySuggestion(text: string): void {
    setDraft(text);
    clearFollowUpSuggestions(session.id);
  }

  const toggleVoiceInput = () => {
    setComposerMenuOpen(false);
    const existing = voiceRecognitionRef.current;
    if (existing) {
      try { existing.stop(); } catch { /* ignore */ }
      voiceRecognitionRef.current = null;
      setVoiceListening(false);
      return;
    }

    const SpeechRecognitionImpl = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) {
      setAttachError(t("chat.voiceUnsupported"));
      return;
    }

    const recognition = new SpeechRecognitionImpl();
    recognition.lang = locale.value.startsWith("ja") ? "ja-JP" : "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    let finalized = "";
    recognition.onstart = () => setVoiceListening(true);
    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i]?.[0]?.transcript ?? "";
        if (event.results[i]?.isFinal) finalized += piece;
        else interim += piece;
      }
      const next = `${finalized}${interim}`.trimStart();
      if (next) setDraft((current) => {
        // Replace current draft while dictating for predictable UX.
        return next;
      });
    };
    recognition.onerror = (event: any) => {
      const code = typeof event?.error === "string" ? event.error : "";
      if (code && code !== "aborted" && code !== "no-speech") {
        setAttachError(t("chat.voiceUnsupported"));
      }
      setVoiceListening(false);
      voiceRecognitionRef.current = null;
    };
    recognition.onend = () => {
      // Keep listening only while this instance is still active.
      if (voiceRecognitionRef.current !== recognition) return;
      setVoiceListening(false);
      voiceRecognitionRef.current = null;
    };

    voiceRecognitionRef.current = recognition;
    try {
      recognition.start();
      setVoiceListening(true);
      setAttachError(undefined);
    } catch {
      setVoiceListening(false);
      voiceRecognitionRef.current = null;
      setAttachError(t("chat.voiceUnsupported"));
    }
  };

  useEffect(() => () => {
    const active = voiceRecognitionRef.current;
    if (!active) return;
    try { active.stop(); } catch { /* ignore */ }
    voiceRecognitionRef.current = null;
  }, []);

  return (
    <article
      class={`chat-pane ${isActive ? "is-active" : ""} ${hideHeader ? "is-headerless" : ""}`}
      style={{ "--session-color": profile.color }}
      onPointerDown={() => {
        if (activateWorkspaceOnPointerDown && activeSessionId.value !== session.id) openSession(session.id);
      }}
    >
      {!hideHeader && (
        <header
          class="chat-header"
          draggable
          title={t("workspace.dragPane")}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer?.setData("application/x-hermes-session", session.id);
            event.dataTransfer?.setData("text/plain", session.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            if (event.currentTarget instanceof HTMLElement) {
              event.currentTarget.classList.add("is-dragging");
            }
          }}
          onDragEnd={(event) => {
            if (event.currentTarget instanceof HTMLElement) {
              event.currentTarget.classList.remove("is-dragging");
            }
          }}
        >
          <span class="profile-dot" style={{ background: profile.color }} />
          <div>
            <b>{profileName}</b>
            <span>{displayTitle}</span>
          </div>
          <span
            class={`chat-state state-${session.connectionState ?? session.status}`}
            role="img"
            aria-label={statusText}
            title={statusText}
          />
          <label
            class="chat-placement-control"
            title={t("layout.handleTitle")}
            draggable={false}
            onPointerDown={(event) => event.stopPropagation()}
            onDragStart={(event) => event.preventDefault()}
          >
            <span class="visually-hidden">{t("appearance.layout")}</span>
            <select
              value={workspacePlacement.value}
              aria-label={t("appearance.layout")}
              onChange={(event) => setWorkspacePlacement(event.currentTarget.value as WorkspacePlacement)}
            >
              <option value="left">{t("appearance.placement.left")}</option>
              <option value="right">{t("appearance.placement.right")}</option>
              <option value="top">{t("appearance.placement.top")}</option>
              <option value="bottom">{t("appearance.placement.bottom")}</option>
            </select>
          </label>
          <button
            class="icon-button"
            draggable={false}
            onPointerDown={(event) => event.stopPropagation()}
            onDragStart={(event) => event.preventDefault()}
            onClick={() => {
              if (onClosePane) onClosePane();
              else closeSession(session.id);
            }}
            aria-label={t("chat.close", { title: displayTitle })}
            title={t("chat.close", { title: displayTitle })}
          ><CloseIcon width={18} height={18} /></button>
        </header>
      )}

      <div
        class="message-list"
        aria-live="polite"
        ref={messageListRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          shouldStickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
        }}
      >
        <div class="message-list-content">
          {session.errorMessage ? (
            <div class="chat-connection-note is-error" role="alert">
              <span>{localizeRuntimeMessage(session.errorMessage)}</span>
              {isLiveChat && (session.connectionState === "error" || session.historyState === "error") && <button type="button" onClick={() => reconnectChatSession(session.id)}>{session.historyState === "error" ? t("chat.reload") : t("chat.reconnect")}</button>}
            </div>
          ) : session.connectionState === "disconnected" && isLiveChat && session.messages.length === 0 ? (
            <div class="chat-connection-note"><span>{t("chat.recovering")}</span></div>
          ) : null}
          {session.historyPartial && <div class="chat-connection-note"><span>{session.historyNotice ? localizeRuntimeMessage(session.historyNotice) : t("chat.historyPartial")}</span></div>}
          {timeline.length === 0 ? (
            <div class="empty-chat">
              <span>{session.historyState === "loading" ? t("chat.loadingHistory") : isLiveChat ? t("chat.hermesSession") : t("chat.newThread")}</span>
              <p>{session.historyState === "loading" ? t("chat.loadingSaved") : !isConnected ? t("chat.connectingLive") : runActive ? t("chat.runningPlaceholder") : t("chat.firstInstruction", { name: profileName })}</p>
            </div>
          ) : timeline.map((item) => item.kind === "operation" ? (
            <ChatOperationEntry key={`operation:${item.operation.id}`} operation={item.operation} />
          ) : item.kind === "log-group" ? (
            <ChatLogGroup
              key={`log-group:${item.id}`}
              group={item}
              expanded={expandedLogGroups.has(item.id)}
              onToggle={() => setExpandedLogGroups((current) => {
                const next = new Set(current);
                if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                return next;
              })}
              profile={profile}
              profileName={profileName}
            />
          ) : (
            <ChatMessageEntry key={`message:${item.message.id}`} message={item.message} profile={profile} profileName={profileName} />
          ))}
          {session.pendingInteraction && (
            <ChatInteraction
              sessionId={session.id}
              interaction={session.pendingInteraction}
              connected={session.connectionState === "ready"}
            />
          )}
        </div>
      </div>
      <span
        class="visually-hidden"
        role={announcedOperation && isUrgentOperation(announcedOperation) ? "alert" : "status"}
        aria-live={announcedOperation && isUrgentOperation(announcedOperation) ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {announcedOperation ? operationAnnouncementText(announcedOperation) : ""}
      </span>

      {suggestions.length > 0 && canSend && (
        <div class="chat-suggestions" aria-label={t("chat.suggestions")}>
          <span>{t("chat.suggestions")}</span>
          <div class="chat-suggestion-list">
            {suggestions.map((item) => (
              <button
                key={item}
                type="button"
                class="chat-suggestion-chip"
                title={t("chat.suggestions.use")}
                onClick={() => applySuggestion(item)}
              >{item}</button>
            ))}
          </div>
        </div>
      )}

      <form class="composer" onSubmit={(event) => void submit(event)}>
        {attachments.length > 0 && (
          <div class="composer-attachments" aria-label={t("chat.attach")}>
            {attachments.map((item) => (
              <div class="composer-attachment" key={item.id}>
                {item.kind === "image" && item.dataUrl
                  ? <img src={item.dataUrl} alt={item.name} />
                  : <span aria-hidden="true">📄</span>}
                <b title={item.name}>{item.name}</b>
                <button type="button" aria-label={t("chat.attachRemove")} title={t("chat.attachRemove")} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}><CloseIcon width={14} height={14} /></button>
              </div>
            ))}
          </div>
        )}
        <div class="composer-toolbar">
          <input
            ref={fileInputRef}
            class="visually-hidden"
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.toml,.sh"
            onChange={(event) => void addFiles(event.currentTarget.files)}
          />
          <button type="button" class="composer-tool" disabled={!canCompose} title={t("chat.attach")} aria-label={t("chat.attach")} onClick={() => { setComposerMenuOpen(false); fileInputRef.current?.click(); }}><AttachIcon width={20} height={20} /></button>
          <div class="composer-menu-wrap" ref={composerMenuRef}>
            <button
              type="button"
              class={`composer-tool composer-menu-trigger ${composerMenuOpen ? "is-open" : ""}`}
              title={t("chat.menu")}
              aria-label={t("chat.menu")}
              aria-expanded={composerMenuOpen}
              onClick={() => setComposerMenuOpen(!composerMenuOpen)}
            ><MenuIcon width={20} height={20} /></button>
            {composerMenuOpen && (
              <div class="composer-menu-panel" role="menu">
                <button type="button" role="menuitem" class="composer-menu-item" onClick={() => { fileInputRef.current?.click(); setComposerMenuOpen(false); }}>
                  <span class="composer-menu-item-label">{t("chat.menu.files")}</span>
                </button>
                <button type="button" role="menuitem" class="composer-menu-item" onClick={() => { setModelOpen(true); setModelNote(undefined); setComposerMenuOpen(false); }}>
                  <span class="composer-menu-item-label">{t("chat.menu.settings")}</span>
                </button>
                <button type="button" role="menuitem" class="composer-menu-item" onClick={() => setComposerMenuOpen(false)}>
                  <span class="composer-menu-item-label">{t("chat.menu.goal")}</span>
                  <small>{t("chat.menu.goalHint")}</small>
                </button>
                <button type="button" role="menuitem" class="composer-menu-item" onClick={() => setComposerMenuOpen(false)}>
                  <span class="composer-menu-item-label">{t("chat.menu.planMode")}</span>
                  <small>{t("chat.menu.planModeHint")}</small>
                </button>
              </div>
            )}
          </div>
          <ComposerModelPickers
            profileId={profile.id}
            sessionId={session.id}
            sessionProvider={session.provider}
            sessionModel={session.model}
            sessionReasoningEffort={session.reasoningEffort}
            canSend={canSend}
            onQueued={() => setModelNote(t("chat.model.queued"))}
            onOpenAdvanced={(providerHint) => {
              setComposerMenuOpen(false);
              setModelProviderHint(providerHint);
              setModelOpen(true);
              setModelNote(undefined);
            }}
            onInteract={() => setComposerMenuOpen(false)}
          />
          {session.pendingModelChange && (
            <small class="composer-model-pending" role="status">
              <span>{t("chat.model.pendingSwitch", { model: session.pendingModelChange.model })}</span>
              <button
                type="button"
                aria-label={t("chat.model.pendingCancel")}
                title={t("chat.model.pendingCancel")}
                disabled={session.pendingModelChange.applying === true}
                onClick={() => cancelSessionModelChange(session.id)}
              >×</button>
            </small>
          )}
          {presetReadout && (
            <small class="composer-model-readout" title={t("chat.model.hint")}>
              <span class="composer-model-preset-name">{t("chat.modelPreset.readout", { name: presetReadout })}</span>
            </small>
          )}
        </div>
        {modelOpen && (
          <ChatModelPanel
            profileId={profile.id}
            sessionId={session.id}
            sessionProvider={session.provider}
            sessionModel={session.model}
            sessionReasoningEffort={session.reasoningEffort}
            initialProvider={modelProviderHint}
            canSend={canSend}
            onClose={() => { setModelOpen(false); setModelProviderHint(undefined); setModelNote(undefined); }}
            onQueued={() => setModelNote(t("chat.model.queued"))}
          />
        )}
        <div class="composer-main">
          {slashSuggestions.length > 0 && (
            <div class="composer-slash-menu" role="listbox" aria-label={t("chat.slash.suggestions")}>
              {slashSuggestions.map((item, index) => (
                <button
                  key={item.text}
                  type="button"
                  role="option"
                  aria-selected={index === slashIndex}
                  class={index === slashIndex ? "is-active" : undefined}
                  onClick={() => {
                    setDraft(`${item.text} `);
                    (messageListRef.current?.closest(".chat-pane")?.querySelector("textarea") as HTMLTextAreaElement | null)?.focus();
                  }}
                >
                  <b>{item.text}</b>
                  {item.meta && <small>{item.meta}</small>}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            disabled={!canCompose}
            aria-busy={session.steerPending === true || session.slashPending === true}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (slashSuggestions.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((current) => (current + 1) % slashSuggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((current) => (current <= 0 ? slashSuggestions.length - 1 : current - 1));
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashDismissed(true);
                  setSlashIndex(-1);
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && slashIndex >= 0)) {
                  const chosen = slashSuggestions[slashIndex >= 0 ? slashIndex : 0];
                  if (chosen) {
                    event.preventDefault();
                    setDraft(`${chosen.text} `);
                    setSlashIndex(-1);
                    return;
                  }
                }
              }
              if (shouldSubmitComposerKey(event)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onPaste={(event) => {
              const files = event.clipboardData?.files;
              const text = event.clipboardData?.getData("text/plain") ?? "";
              if (files && files.length > 0 && !text.trim()) {
                event.preventDefault();
                void addFiles(files);
              } else if (files && files.length > 0) {
                // Prefer keeping typed/pasted text; still stage image files without blocking text.
                void addFiles(files);
              }
            }}
            placeholder={composerPlaceholder}
            aria-label={composerPlaceholder}
            rows={2}
          />
          <div class="composer-actions">
            <button
              type="button"
              class={`composer-tool composer-voice-btn ${voiceListening ? "is-listening" : ""}`}
              disabled={!canCompose && !voiceListening}
              title={voiceListening ? t("chat.voiceListening") : t("chat.voice")}
              aria-label={t("chat.voice")}
              aria-pressed={voiceListening}
              onClick={toggleVoiceInput}
            >{voiceListening ? <StopIcon width={18} height={18} /> : <MicIcon width={18} height={18} />}</button>
            <button
              type="submit"
              class="composer-send"
              disabled={submitDisabled}
              title={runActive ? t("chat.steer") : t("chat.send")}
              aria-label={runActive ? t("chat.steer") : t("chat.send")}
            >
              {runActive ? <SteerIcon width={18} height={18} /> : <SendIcon width={18} height={18} />}
            </button>
            {showStop && <button type="button" class="interrupt-button" aria-busy={session.interruptPending === true} aria-label={session.interruptPending ? t("chat.stopping") : t("chat.stop")} title={session.interruptPending ? t("chat.stopping") : t("chat.stop")} disabled={session.connectionState !== "ready" || session.interruptPending === true} onClick={() => void interruptSession(session.id)}><StopIcon width={18} height={18} /></button>}
          </div>
        </div>
        {(attachError || modelNote || blocked) && (
          <p class={`composer-note ${attachError ? "is-error" : ""}`}>
            {attachError ?? modelNote ?? (blocked ? t(`chat.blocked.${blocked}` as TranslationKey) : "")}
            {blocked === "disconnected" && isLiveChat && (
              <button type="button" onClick={() => reconnectChatSession(session.id)}>{t("chat.reconnect")}</button>
            )}
          </p>
        )}
      </form>
    </article>
  );
}

export function shouldSubmitComposerKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function formatChatMessageTime(
  value: string,
  selectedLocale: "ja" | "en" = locale.value,
  timeZone?: string
): string {
  if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(selectedLocale === "ja" ? "ja-JP" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone })
  }).format(date);
}

function operationStateTranslation(state: ChatOperationEvidence["state"]): TranslationKey {
  return ({
    pending: "chat.prompt.pending",
    accepted: "chat.prompt.accepted",
    rejected: "chat.prompt.rejected",
    unconfirmed: "chat.prompt.unconfirmed",
  } as const)[state];
}

export function presentedOperationEvidence(session: Pick<ChatSession, "messages" | "operationEvidence">): ChatOperationEvidence[] {
  const legacy = session.messages.flatMap<ChatOperationEvidence>((message): ChatOperationEvidence[] => {
    if (message.promptOperation) return [{
      id: message.promptOperation.id, kind: "prompt" as const, body: message.body, at: message.at,
      timelineSequence: message.timelineSequence,
      state: message.promptOperation.state,
      ...(message.promptOperation.message ? { message: message.promptOperation.message } : {}),
    }];
    return message.kind === "steer"
      ? [{
          id: message.id,
          timelineSequence: message.timelineSequence,
          kind: "steer" as const,
          body: message.body,
          at: message.at,
          state: "accepted" as const,
        }]
      : [];
  });
  return [...(session.operationEvidence ?? []), ...legacy];
}

type ChatTimelineItem =
  | { kind: "message"; message: ChatMessage; sequence: number }
  | { kind: "operation"; operation: ChatOperationEvidence; sequence: number };

type ChatLogGroup = {
  kind: "log-group";
  id: string;
  messages: ChatMessage[];
  sequence: number;
};

type PresentedChatTimelineItem = ChatTimelineItem | ChatLogGroup;

export function buildChatTimeline(messages: readonly ChatMessage[], evidence: readonly ChatOperationEvidence[]): ChatTimelineItem[] {
  const timeline: ChatTimelineItem[] = [
    ...messages.map((message, sequence) => ({ kind: "message" as const, message, sequence })),
    ...evidence.map((operation, index) => ({ kind: "operation" as const, operation, sequence: messages.length + index })),
  ];
  const sequenced = timeline.filter((item) => timelineSequence(item) !== undefined);
  if (sequenced.length === timeline.length) return timeline.sort(compareTimelineSequence);
  if (sequenced.length > 0) return mergePartiallySequencedTimeline(timeline, sequenced);
  const times = timeline.map((item) => comparableTimelineTime(item.kind === "message" ? item.message.at : item.operation.at));
  if (times.some((time) => time === undefined) || new Set(times.map((time) => time?.kind)).size !== 1) return timeline;
  // A date-less clock cannot prove a day boundary. Legacy rows without the
  // shared sequence retain their source order instead of inventing chronology.
  if (times[0]?.kind === "clock") return timeline;
  return timeline.sort((left, right) => {
    const leftTime = comparableTimelineTime(left.kind === "message" ? left.message.at : left.operation.at);
    const rightTime = comparableTimelineTime(right.kind === "message" ? right.message.at : right.operation.at);
    if (leftTime && rightTime && leftTime.value !== rightTime.value) {
      return leftTime.value - rightTime.value;
    }
    return left.sequence - right.sequence;
  });
}

function timelineSequence(item: ChatTimelineItem): number | undefined {
  const value = item.kind === "message" ? item.message.timelineSequence : item.operation.timelineSequence;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function compareTimelineSequence(left: ChatTimelineItem, right: ChatTimelineItem): number {
  const leftSequence = timelineSequence(left)!;
  const rightSequence = timelineSequence(right)!;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  const timeOrder = compareComparableTimelineTimes(left, right);
  return timeOrder === 0 ? left.sequence - right.sequence : timeOrder;
}

function mergePartiallySequencedTimeline(
  timeline: readonly ChatTimelineItem[],
  sequenced: readonly ChatTimelineItem[],
): ChatTimelineItem[] {
  const anchors = [...sequenced].sort(compareTimelineSequence);
  const missing = timeline.filter((item) => timelineSequence(item) === undefined);
  const timedAnchors = anchors.map((item, index) => ({
    index,
    time: comparableTimelineTime(item.kind === "message" ? item.message.at : item.operation.at),
  }));
  const positioned = [
    ...anchors.map((item, index) => ({ item, position: index, anchor: true })),
    ...missing.map((item) => {
      const time = comparableTimelineTime(item.kind === "message" ? item.message.at : item.operation.at);
      const matchingAnchors = time === undefined
        ? []
        : timedAnchors.flatMap((entry) => entry.time?.kind === time.kind
          ? [{ index: entry.index, time: entry.time }]
          : []);
      if (time === undefined || matchingAnchors.length === 0) {
        // With no comparable anchor the historical position is unknowable.
        // Put it before the trusted sequence so later appends cannot move it.
        return { item, position: -1, anchor: false };
      }
      const axes = timelineAxis(matchingAnchors.map(({ time: anchorTime }) => anchorTime), time.kind);
      const target = nearestTimelineAxis(time.value, axes[0]!, axes[axes.length - 1]!, time.kind);
      let position = matchingAnchors[0]!.index - 0.5;
      for (let index = 0; index < matchingAnchors.length; index += 1) {
        const current = matchingAnchors[index]!;
        const currentAxis = axes[index]!;
        if (target < currentAxis) break;
        const next = matchingAnchors[index + 1];
        const nextAxis = axes[index + 1];
        if (next === undefined || nextAxis === undefined) {
          position = current.index + 0.5;
          break;
        }
        if (target <= nextAxis) {
          const ratio = nextAxis === currentAxis ? 0.5 : (target - currentAxis) / (nextAxis - currentAxis);
          position = current.index + ratio * (next.index - current.index);
          break;
        }
      }
      return { item, position, anchor: false };
    }),
  ];
  return positioned.sort((left, right) => {
    if (left.position !== right.position) return left.position - right.position;
    if (left.anchor && right.anchor) return compareTimelineSequence(left.item, right.item);
    return left.item.sequence - right.item.sequence;
  }).map(({ item }) => item);
}

function timelineAxis(
  times: readonly NonNullable<ReturnType<typeof comparableTimelineTime>>[],
  kind: "absolute" | "clock",
): number[] {
  if (kind === "absolute") {
    let previous = Number.NEGATIVE_INFINITY;
    return times.map((time) => {
      previous = Math.max(previous, time.value);
      return previous;
    });
  }
  const day = 24 * 60 * 60;
  let previous = Number.NEGATIVE_INFINITY;
  return times.map((time) => {
    let value = time.value;
    while (value < previous) value += day;
    previous = value;
    return value;
  });
}

function nearestTimelineAxis(value: number, first: number, last: number, kind: "absolute" | "clock"): number {
  if (kind === "absolute") return value;
  const day = 24 * 60 * 60;
  const firstDay = Math.floor(first / day);
  const lastDay = Math.floor(last / day);
  let best = value;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let dayOffset = firstDay - 1; dayOffset <= lastDay + 1; dayOffset += 1) {
    const candidate = value + dayOffset * day;
    const distance = candidate < first ? first - candidate : candidate > last ? candidate - last : 0;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function compareComparableTimelineTimes(left: ChatTimelineItem, right: ChatTimelineItem): number {
  const leftTime = comparableTimelineTime(left.kind === "message" ? left.message.at : left.operation.at);
  const rightTime = comparableTimelineTime(right.kind === "message" ? right.message.at : right.operation.at);
  // Absolute timestamps can safely break a legacy sequence collision. A
  // date-less clock cannot establish which side of midnight came first.
  return leftTime?.kind === "absolute" && rightTime?.kind === "absolute" ? leftTime.value - rightTime.value : 0;
}

export function groupChatTimeline(timeline: readonly ChatTimelineItem[]): PresentedChatTimelineItem[] {
  const grouped: PresentedChatTimelineItem[] = [];
  let pending: ChatMessage[] = [];
  let pendingSequence = 0;

  const flush = () => {
    if (pending.length === 0) return;
    grouped.push({
      kind: "log-group",
      // Stable across mid-stream appends: first tool message id anchors the run.
      id: pending[0]!.id,
      messages: pending,
      sequence: pendingSequence,
    });
    pending = [];
  };

  for (const item of timeline) {
    if (item.kind === "message" && isCompactLogMessage(item.message)) {
      if (pending.length === 0) pendingSequence = item.sequence;
      pending.push(item.message);
      continue;
    }
    flush();
    grouped.push(item);
  }
  flush();
  return grouped;
}

function isCompactLogMessage(message: ChatMessage): boolean {
  if (message.status === "failed" || message.status === "cancelled") return false;
  return message.from === "tool"
    || message.presentation?.kind === "tool-fallback"
    || message.body.trim() === "[Tool output hidden]";
}

function ChatLogGroup({
  group,
  expanded,
  onToggle,
  profile,
  profileName,
}: {
  group: ChatLogGroup;
  expanded: boolean;
  onToggle: () => void;
  profile: Profile;
  profileName: string;
}) {
  const latest = group.messages.at(-1);
  const preview = latest && latest.body.trim() !== "[Tool output hidden]"
    ? displayProfileReferences(chatMessageBody(latest), profileList.value)
    : t("chat.tool");
  return (
    <section class={`chat-log-group ${expanded ? "is-expanded" : ""}`}>
      <button type="button" class="chat-log-group-toggle" aria-expanded={expanded} onClick={onToggle}>
        <span class="chat-log-group-icon" aria-hidden="true">⚙</span>
        <b>{t("chat.logs.group", { count: group.messages.length })}</b>
        <small>{expanded ? t("chat.logs.collapse") : t("chat.logs.expand")}</small>
        <span class="chat-log-group-preview">{preview}</span>
      </button>
      {expanded && (
        <div class="chat-log-group-items">
          {group.messages.map((message) => <ChatMessageEntry key={message.id} message={message} profile={profile} profileName={profileName} />)}
        </div>
      )}
    </section>
  );
}

function ChatMessageEntry({ message, profile, profileName }: { message: ChatMessage; profile: Profile; profileName: string }) {
  const body = chatMessageBody(message);
  const displayReferences = (value: string) => displayProfileReferences(value, profileList.value);
  const displayedToolBody = message.from === "tool" ? displayReferences(body) : body;
  if (message.from === "user") {
    return <UserInstructionEntry body={body} at={message.at} status={message.status ?? "complete"} />;
  }
  return (
    <div
      class={`message message-${message.from} message-${message.status ?? "complete"}`}
      style={message.from === "agent" ? { "--agent-color": profile.color } : undefined}
    >
      <span class="visually-hidden">{message.from === "tool" ? t("chat.tool") : profileName}</span>
      {message.from === "tool" && <span class="message-tool-mark" aria-hidden="true">⚙</span>}
      {message.from === "tool"
        ? <p>{displayedToolBody || (message.status === "streaming" ? "…" : "")}</p>
        : <MarkdownBody
            text={body}
            streaming={message.status === "streaming"}
            {...(message.from === "agent" ? { transformText: displayReferences } : {})}
          />}
      <time>{formatChatMessageTime(message.at)}</time>
    </div>
  );
}

export function nextOperationAnnouncement(
  evidence: readonly ChatOperationEvidence[],
  previousKey: string,
): { key: string; operation: ChatOperationEvidence } | undefined {
  const operation = evidence.at(-1);
  if (!operation) return undefined;
  const key = `${operation.id}\0${operation.state}\0${operation.message ?? ""}`;
  return key === previousKey ? undefined : { key, operation };
}

export function operationAnnouncementText(operation: ChatOperationEvidence): string {
  const kind = operation.kind === "steer" ? t("chat.operation.steer") : t("chat.operation.prompt");
  const state = t(operationStateTranslation(operation.state));
  const body = operation.body.length > 160 ? `${operation.body.slice(0, 160)}…` : operation.body;
  return t("chat.operation.announcement", { kind, state, body });
}

function isUrgentOperation(operation: ChatOperationEvidence): boolean {
  return operation.state === "rejected" || operation.state === "unconfirmed";
}

function ChatOperationEntry({ operation }: { operation: ChatOperationEvidence }) {
  return <UserInstructionEntry body={operation.body} at={operation.at} status={operation.state} operation />;
}

function UserInstructionEntry({
  body,
  at,
  status,
  operation = false,
}: {
  body: string;
  at: string;
  status: ChatMessage["status"] | ChatOperationEvidence["state"];
  operation?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element || expanded) return;
    const measure = () => setCanExpand(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [body, expanded]);

  useEffect(() => () => {
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
  }, []);

  const copyInstruction = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard permission can be denied by the host; keep the message intact.
    }
  };

  return (
    <div
      class={`message message-user message-${status ?? "complete"} user-instruction${operation ? ` chat-operation is-${status}` : ""}`}
      aria-live="off"
    >
      <span class="visually-hidden">{t("chat.you")}</span>
      <div ref={bodyRef} class={`user-instruction-body ${expanded ? "is-expanded" : "is-collapsed"}`}>
        <MarkdownBody text={body} />
      </div>
      <div class="user-instruction-utilities">
        <time dateTime={at}>{formatChatMessageTime(at)}</time>
        <button
          type="button"
          class={`user-instruction-copy${copied ? " is-copied" : ""}`}
          title={copied ? t("chat.message.copied") : t("chat.message.copy")}
          aria-label={copied ? t("chat.message.copied") : t("chat.message.copy")}
          onClick={() => void copyInstruction()}
        >
          <CopyIcon width={14} height={14} />
        </button>
      </div>
      {canExpand && (
        <button
          type="button"
          class="user-instruction-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("chat.message.showLess") : t("chat.message.showMore")}
        </button>
      )}
    </div>
  );
}

function comparableTimelineTime(value: string): { kind: "absolute" | "clock"; value: number } | undefined {
  const clock = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)(?::(?<second>[0-5]\d))?$/.exec(value)?.groups;
  if (clock) return { kind: "clock", value: Number(clock.hour) * 3600 + Number(clock.minute) * 60 + Number(clock.second ?? 0) };
  const absolute = Date.parse(value);
  return Number.isNaN(absolute) ? undefined : { kind: "absolute", value: absolute };
}


export function chatComposerState(session: ChatSession): { canCompose: boolean; canSteer: boolean; runActive: boolean; showStop: boolean } {
  const runActive = isChatRunActive(session);
  const canSteer = canSteerChatSession(session);
  const showStop = runActive && (session.remoteKind === "stored" || session.remoteKind === "draft");
  return { runActive, canSteer, canCompose: canSubmitChatPrompt(session) || canSteer, showStop };
}

function ChatInteraction({ sessionId, interaction, connected }: {
  sessionId: string;
  interaction: ChatPendingInteraction;
  connected: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const disabled = !connected || interaction.submitting;

  useEffect(() => setAnswer(""), [interaction.id]);

  if (interaction.kind === "approval") {
    const canApprovePermanently = interaction.allowPermanent
      && officeSnapshot.value?.capabilities.access.allowedOperations.includes("chat.approval.permanent") === true;
    const choices = approvalChoicesForAccess(interaction, canApprovePermanently);
    return (
      <section class="chat-interaction approval-interaction" aria-label={t("chat.approvalAria")}>
        <span class="interaction-kicker">{t("chat.approvalRequired")}</span>
        <h3>{interaction.description || t("chat.approvalFallback")}</h3>
        {interaction.command && <pre><code>{interaction.command}</code></pre>}
        {interaction.error && <p class="interaction-error" role="alert">{localizeRuntimeMessage(interaction.error)}</p>}
        {!connected && <p class="interaction-note">{t("chat.approvalOffline")}</p>}
        <div class="interaction-actions">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              class={choice === "deny" ? "is-deny" : choice === "always" ? "is-permanent" : ""}
              disabled={disabled || (choice === "always" && !canApprovePermanently)}
              onClick={() => void respondToApproval(sessionId, choice)}
            >
              {approvalLabel(choice)}
            </button>
          ))}
        </div>
        {interaction.submitting && <span class="interaction-progress">{t("chat.submitting")}</span>}
      </section>
    );
  }

  return (
    <section class="chat-interaction clarify-interaction" aria-label={t("chat.clarifyAria")}>
      <span class="interaction-kicker">{t("chat.clarification")}</span>
      <h3>{interaction.question}</h3>
      {interaction.error && <p class="interaction-error" role="alert">{localizeRuntimeMessage(interaction.error)}</p>}
      {!connected && <p class="interaction-note">{t("chat.clarifyOffline")}</p>}
      {interaction.choices.length > 0 && (
        <div class="interaction-actions">
          {interaction.choices.map((choice) => (
            <button type="button" key={choice} disabled={disabled} onClick={() => void respondToClarification(sessionId, choice)}>{choice}</button>
          ))}
        </div>
      )}
      <form class="clarify-answer" onSubmit={(event) => {
        event.preventDefault();
        void respondToClarification(sessionId, answer);
      }}>
        <input
          value={answer}
          disabled={disabled}
          onInput={(event) => setAnswer(event.currentTarget.value)}
          placeholder={t("chat.freeAnswer")}
          aria-label={t("chat.answerAria")}
        />
        <button type="submit" disabled={disabled || !answer.trim()}>{t("chat.answer")}</button>
      </form>
      {interaction.submitting && <span class="interaction-progress">{t("chat.submitting")}</span>}
    </section>
  );
}

export function approvalChoicesForAccess(
  interaction: Extract<ChatPendingInteraction, { kind: "approval" }>,
  canApprovePermanently: boolean,
): ApprovalChoice[] {
  return interaction.choices.filter((choice) => choice !== "always" || canApprovePermanently);
}

function approvalLabel(choice: ApprovalChoice): string {
  if (choice === "once") return t("approval.once");
  if (choice === "session") return t("approval.session");
  if (choice === "always") return t("approval.always");
  return t("approval.deny");
}
