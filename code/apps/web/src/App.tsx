import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  Backpack,
  BadgeCheck,
  Banknote,
  BookOpen,
  Check,
  Coins,
  Crown,
  Eye,
  Gavel,
  Handshake,
  History,
  Pause,
  Play,
  RefreshCw,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Timer,
  UserMinus,
  X
} from "lucide-react";
import type { ActiveEffect, AuctionMode, ChoiceResolution, ClientToServerEvents, EventCard, GamePhase, PhaseTimeouts, PlayerView, PublicArtifactView, RoleSkill, TrickCard } from "@auctioneer/shared";
import { CATEGORY_LABELS, TAG_LABELS } from "@auctioneer/shared";
import { CardPreviewShowcase, isCardPreviewRoute } from "./CardPreviewShowcase";
import { ActiveSkillShowcase, isActiveSkillShowcaseRoute } from "./ActiveSkillShowcase";
import { clearSession, createGameSocket, loadSession, saveSession, summarizeView, type GameSocket } from "./socket";
import { useBackgroundMusic } from "./useBackgroundMusic";

gsap.registerPlugin(useGSAP);

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };
type PlayableCard = TrickCard | EventCard;
type CardVaultKind = "tricks" | "events";
type TargetMode = "none" | "player" | "artifact" | "ownedArtifact" | "playerArtifact" | "playerAuctionArtifact" | "playerMission" | "playerSwap";
type TargetRequest =
  | { kind: "card"; card: PlayableCard; defaultArtifactId?: string }
  | { kind: "role"; skill: RoleSkill }
  | { kind: "consignment"; card: PlayableCard; defaultArtifactId?: string };
type AppNotice =
  | { kind: "auction"; id: string; title: string }
  | { kind: "purchase"; id: string; artifacts: PublicArtifactView[] }
  | { kind: "blackMarketPurchase"; id: string; card: PlayableCard; cardKind: "trick" | "event"; cost: number; remainingCash: number }
  | { kind: "commission"; id: string; message: string }
  | { kind: "loanWarning"; id: string; debt: number; loans: number };

const phaseLabels: Record<PlayerView["phase"], string> = {
  lobby: "大厅",
  setup: "设置",
  dayIncome: "晨间收入",
  blackMarket: "黑市",
  preview: "预展",
  cardWindow: "锦囊/事件",
  auction: "竞拍",
  settlement: "结算",
  eventWindow: "事件窗口",
  freeTrade: "自由交易",
  finalScoring: "终局"
};

const configurableTimeoutPhases: GamePhase[] = ["dayIncome", "blackMarket", "preview", "cardWindow", "auction", "settlement", "eventWindow", "freeTrade"];

const rolePortraitById: Record<string, string> = {
  role01: "/roles/role01.png",
  role02: "/roles/role02.png",
  role03: "/roles/role03.png",
  role04: "/roles/role04.png",
  role05: "/roles/role05.png",
  role06: "/roles/role06.png",
  role07: "/roles/role07.png",
  role08: "/roles/role08.png",
  role09: "/roles/role09.png"
};

function getRolePortrait(roleId?: string): string | undefined {
  return roleId ? rolePortraitById[roleId] : undefined;
}

export function App() {
  if (isCardPreviewRoute()) return <CardPreviewShowcase />;
  if (isActiveSkillShowcaseRoute()) return <ActiveSkillShowcase />;

  const appRef = useRef<HTMLElement | null>(null);
  const socketRef = useRef<GameSocket | null>(null);
  const [view, setView] = useState<PlayerView>();
  const [nickname, setNickname] = useState("玩家");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [bidAmount, setBidAmount] = useState(10);
  const [dutchStepAmount, setDutchStepAmount] = useState(10);
  const [sealedAmount, setSealedAmount] = useState(0);
  const [targetRequest, setTargetRequest] = useState<TargetRequest>();
  const [confirmCard, setConfirmCard] = useState<PlayableCard>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scoreboardOpen, setScoreboardOpen] = useState(false);
  const [backpackOpen, setBackpackOpen] = useState(false);
  const [cardVaultOpen, setCardVaultOpen] = useState<CardVaultKind | undefined>(undefined);
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const bgm = useBackgroundMusic(view?.day);
  const [loanConfirmOpen, setLoanConfirmOpen] = useState(false);
  const [sellConfirmArtifactId, setSellConfirmArtifactId] = useState<string>();
  const [incomeRollsOpen, setIncomeRollsOpen] = useState(false);
  const [roleRevealOpen, setRoleRevealOpen] = useState(false);
  const [choiceEffect, setChoiceEffect] = useState<ActiveEffect | undefined>(undefined);
  const [dismissedChoiceIds, setDismissedChoiceIds] = useState<string[]>([]);
  const [projectionOpen, setProjectionOpen] = useState(false);
  const [notices, setNotices] = useState<AppNotice[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "disconnected" | "recovering" | "failed">("connecting");
  const [now, setNow] = useState(Date.now());
  const seenAuctionNoticeRef = useRef<Set<string>>(new Set());
  const seenArtifactIdsRef = useRef<Set<string> | undefined>(undefined);
  const incomeRollPhaseRef = useRef<GamePhase | undefined>(undefined);
  const previousPrivateLogRef = useRef<string[]>([]);
  const notice = notices[0];
  function enqueueNotice(nextNotice: AppNotice) {
    setNotices((current) => (current.some((item) => item.id === nextNotice.id) ? current : [...current, nextNotice]));
  }
  function closeNotice() {
    setNotices((current) => current.slice(1));
  }

  useEffect(() => {
    const socket = createGameSocket();
    socketRef.current = socket;
    socket.on("room:update", (nextView) => {
      if (nextView.self.kicked) {
        clearSession();
        setView(undefined);
        setConnectionStatus("failed");
        setError("你已被房主移出房间。");
        return;
      }
      setView(nextView);
      setConnectionStatus(socket.connected ? "connected" : "connecting");
      setError("");
    });
    socket.on("room:redirect", (data: { newRoomId: string; joinCode: string; newPlayerId: string; sessionToken: string }) => {
      clearSession();
      saveSession({ roomId: data.newRoomId, playerId: data.newPlayerId, sessionToken: data.sessionToken });
      setConnectionStatus("recovering");
      socket.emit("room:resume", { roomId: data.newRoomId, playerId: data.newPlayerId, sessionToken: data.sessionToken }, (response: { ok: boolean; view?: PlayerView; error?: string }) => {
        if (response.ok && response.view) {
          setView(response.view);
          setConnectionStatus("connected");
          setError("");
        }
      });
    });
    socket.on("room:error", (payload) => {
      if (payload.code === "SESSION_INVALID") {
        clearSession();
        setView(undefined);
        setConnectionStatus("failed");
        setSettingsOpen(false);
      setScoreboardOpen(false);
      setBackpackOpen(false);
      setCardVaultOpen(undefined);
      setIncomeRollsOpen(false);
      setRoleRevealOpen(false);
        setTargetRequest(undefined);
        setConfirmCard(undefined);
        setNotices([]);
        setDismissedChoiceIds([]);
        setJoinCode("");
      }
      setError(payload.message);
    });
    const resume = () => {
      const session = loadSession();
      if (!session) {
        setConnectionStatus(socket.connected ? "connected" : "connecting");
        return;
      }
      setConnectionStatus("recovering");
      socket.emit("room:resume", session, (response) => {
      if (response.ok) {
        setView(response.view);
        setError("");
        setConnectionStatus("connected");
        } else {
          clearSession();
          setView(undefined);
          setConnectionStatus("failed");
          setError(`恢复失败：${response.error}`);
        }
      });
    };
    socket.on("connect", resume);
    socket.on("disconnect", () => setConnectionStatus("disconnected"));
    socket.on("connect_error", () => setConnectionStatus("failed"));
    if (socket.connected) resume();
    return () => {
      socket.off("connect", resume);
      socket.off("room:error");
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    window.render_game_to_text = () => summarizeView(view);
    window.advanceTime = () => summarizeView(view);
  }, [view]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (view?.phase === "dayIncome" && view.self.role && !localStorage.getItem(`auctioneer.roleReveal.${view.roomId}.${view.selfId}`)) {
      setRoleRevealOpen(true);
      localStorage.setItem(`auctioneer.roleReveal.${view.roomId}.${view.selfId}`, "1");
    }
  }, [view?.phase, view?.roomId, view?.selfId, view?.self.role?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && view) {
        event.preventDefault();
        setScoreboardOpen(true);
        return;
      }
      if (event.key.toLowerCase() === "b" && view && !isTypingTarget(event.target)) {
        event.preventDefault();
        setBackpackOpen(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        setScoreboardOpen(false);
        return;
      }
      if (event.key.toLowerCase() === "b" && !isTypingTarget(event.target)) {
        event.preventDefault();
        setBackpackOpen(false);
      }
    };
    const closeOverlays = () => {
      setScoreboardOpen(false);
      setBackpackOpen(false);
      setCardVaultOpen(undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", closeOverlays);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", closeOverlays);
    };
  }, [view]);

  useEffect(() => {
    if (!view) {
      seenArtifactIdsRef.current = undefined;
      seenAuctionNoticeRef.current = new Set();
      previousPrivateLogRef.current = [];
      setBackpackOpen(false);
      setCardVaultOpen(undefined);
      setIncomeRollsOpen(false);
      setNotices([]);
      setDismissedChoiceIds([]);
      return;
    }
    seenArtifactIdsRef.current = new Set(view.self.artifacts.map((artifact) => artifact.id));
    seenAuctionNoticeRef.current = new Set();
    previousPrivateLogRef.current = view.privateLog;
    setBackpackOpen(false);
    setCardVaultOpen(undefined);
    setIncomeRollsOpen(false);
    setNotices([]);
    setDismissedChoiceIds([]);
  }, [view?.roomId, view?.selfId]);

  useEffect(() => {
    if (!view) return;
    const artifactIds = new Set(view.self.artifacts.map((artifact) => artifact.id));
    if (!seenArtifactIdsRef.current) {
      seenArtifactIdsRef.current = artifactIds;
      return;
    }
    const previous = seenArtifactIdsRef.current;
    const newArtifacts = view.self.artifacts.filter((artifact) => !previous.has(artifact.id) && artifact.purchasePrice !== undefined);
    seenArtifactIdsRef.current = artifactIds;
    if (newArtifacts.length === 0) return;
    enqueueNotice({
      kind: "purchase",
      id: `purchase:${view.roomId}:${view.selfId}:${newArtifacts.map((artifact) => artifact.id).join(",")}`,
      artifacts: newArtifacts
    });
  }, [view?.roomId, view?.selfId, view?.self.artifacts]);

  useEffect(() => {
    if (!view?.auction || view.phase !== "cardWindow") return;
    const key = `${view.roomId}:${view.day}:${view.auction.id}:${view.auction.mode}:${view.auction.bundleInnerMode ?? ""}`;
    if (seenAuctionNoticeRef.current.has(key)) return;
    seenAuctionNoticeRef.current.add(key);
    enqueueNotice({
      kind: "auction",
      id: `auction:${key}`,
      title: `今天是${auctionModeLabel(view.auction.mode, view.auction.bundleInnerMode)}拍卖`
    });
  }, [view?.roomId, view?.day, view?.phase, view?.auction?.id, view?.auction?.mode, view?.auction?.bundleInnerMode]);

  useEffect(() => {
    if (!view) return;
    const newItems = appendedLogItems(previousPrivateLogRef.current, view.privateLog);
    previousPrivateLogRef.current = view.privateLog;
    for (const item of newItems) {
      if (!item.includes("作为主持人收到") || !item.includes("佣金")) continue;
      enqueueNotice({
        kind: "commission",
        id: `commission:${view.roomId}:${view.selfId}:${Date.now()}:${Math.random()}`,
        message: item
      });
    }
  }, [view?.roomId, view?.selfId, view?.privateLog]);

  useEffect(() => {
    if (!view || view.day !== view.maxDays) return;
    const debt = (view.self.loanRepayments ?? []).reduce((sum, repayment) => sum + repayment, 0);
    if (view.self.loans <= 0 || debt <= 0) return;
    enqueueNotice({
      kind: "loanWarning",
      id: `loan-warning:${view.roomId}:${view.selfId}:${view.day}:${view.self.loans}:${debt}`,
      debt,
      loans: view.self.loans
    });
  }, [view?.roomId, view?.selfId, view?.day, view?.maxDays, view?.self.loans, view?.self.loanRepayments]);

  useEffect(() => {
    if (!view) return;
    const pending = view.activeEffects.find(
      (e) => e.pendingChoice && !dismissedChoiceIds.includes(e.id) && canRespondChoiceEffect(e, view)
    );
    setChoiceEffect(pending);
  }, [view?.activeEffects, view?.selfId, dismissedChoiceIds]);

  const scopedTargets = (selector: string) => Array.from(appRef.current?.querySelectorAll(selector) ?? []);

  useGSAP(
    () => {
      if (!backpackOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const panels = scopedTargets(".backpack-panel");
      if (panels.length) gsap.fromTo(panels, { autoAlpha: 0, y: -14, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.2, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [backpackOpen], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!cardVaultOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const panels = scopedTargets(".card-vault-panel");
      const cards = scopedTargets(".card-vault-panel .game-card-face");
      if (panels.length) gsap.fromTo(panels, { autoAlpha: 0, y: -14, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.2, ease: "power2.out", overwrite: "auto" });
      if (cards.length) gsap.fromTo(cards, { autoAlpha: 0, y: 10, rotationX: -6 }, { autoAlpha: 1, y: 0, rotationX: 0, duration: 0.26, stagger: 0.035, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [cardVaultOpen, view?.self.hand.length, view?.self.events.length], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!notice || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const modals = scopedTargets(".notice-modal");
      if (modals.length) gsap.fromTo(modals, { autoAlpha: 0, y: 18, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.24, ease: "back.out(1.35)", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [notice?.id], revertOnUpdate: true }
  );

  useEffect(() => {
    if (scoreboardOpen) setBackpackOpen(false);
  }, [scoreboardOpen]);

  useEffect(() => {
    if (backpackOpen) setScoreboardOpen(false);
  }, [backpackOpen]);

  useEffect(() => {
    if (!cardVaultOpen) return;
    setScoreboardOpen(false);
    setBackpackOpen(false);
  }, [cardVaultOpen]);

  useEffect(() => {
    if (!view) return;
    setScoreboardOpen(false);
    setBackpackOpen(false);
    setCardVaultOpen(undefined);
    setTargetRequest(undefined);
    setConfirmCard(undefined);
  }, [view?.phase, view?.day]);

  useEffect(() => {
    if (!view) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (projectionOpen) setProjectionOpen(false);
        else if (notice) closeNotice();
        else if (cardVaultOpen) setCardVaultOpen(undefined);
        else setBackpackOpen(false);
      }
      if ((event.key === "`" || event.key === "~" || event.code === "Backquote") && !event.repeat) {
        event.preventDefault();
        if (view.phase !== "finalScoring" && view.projectedScore) {
          setProjectionOpen(true);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      // 松开 ~ 键关闭投影面板
      if ((event.key === "`" || event.key === "~" || event.code === "Backquote") && projectionOpen) {
        setProjectionOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [view, notice, cardVaultOpen, projectionOpen]);

  const tableArtifacts = useMemo(() => {
    if (!view) return [];
    return visibleTableArtifacts(view);
  }, [view]);
  const currentArtifact = useMemo(() => {
    if (!view?.auction) return tableArtifacts[0];
    const artifactId = view.auction.artifactIds[view.auction.currentArtifactIndex];
    return tableArtifacts.find((artifact) => artifact.id === artifactId);
  }, [view, tableArtifacts]);
  const incomeRollSignature = useMemo(
    () => view?.lastIncomeRolls?.map((roll) => `${roll.playerId}:${roll.roll}:${roll.reroll ?? ""}:${roll.amount}`).join("|") ?? "",
    [view?.lastIncomeRolls]
  );

  useEffect(() => {
    if (!view || !incomeRollSignature) return;
    incomeRollPhaseRef.current = view.phase;
    setIncomeRollsOpen(true);
    const timer = window.setTimeout(() => setIncomeRollsOpen(false), 3200);
    return () => window.clearTimeout(timer);
  }, [view?.roomId, view?.day, incomeRollSignature]);

  useEffect(() => {
    if (!view || !incomeRollPhaseRef.current) return;
    if (view.phase !== incomeRollPhaseRef.current) setIncomeRollsOpen(false);
  }, [view?.phase, view?.day]);

  useGSAP(
    () => {
      if (!view || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const panels = scopedTargets(".motion-panel");
      if (!panels.length) return;
      gsap.fromTo(
        panels,
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, duration: 0.32, stagger: 0.035, ease: "power2.out", overwrite: "auto" }
      );
    },
    { scope: appRef, dependencies: [view?.roomId], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!view || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const phaseChips = scopedTargets(".phase-chip");
      const currentCards = scopedTargets(".artifact-card.current");
      if (phaseChips.length) gsap.fromTo(phaseChips, { scale: 0.98 }, { scale: 1, duration: 0.18, ease: "power1.out", overwrite: "auto" });
      if (currentCards.length) gsap.fromTo(currentCards, { y: 8, scale: 0.99 }, { y: 0, scale: 1, duration: 0.26, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [view?.phase, view?.day], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!scoreboardOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const panels = scopedTargets(".scoreboard-panel");
      if (panels.length) gsap.fromTo(panels, { autoAlpha: 0, y: -18, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.18, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [scoreboardOpen], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!roleRevealOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const modals = scopedTargets(".role-reveal-modal");
      if (modals.length) gsap.fromTo(modals, { autoAlpha: 0, y: 18, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: "back.out(1.4)", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [roleRevealOpen], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!incomeRollsOpen || !view?.lastIncomeRolls?.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const cards = scopedTargets(".dice-card");
      const faces = scopedTargets(".dice-face");
      if (cards.length) gsap.fromTo(cards, { autoAlpha: 0, y: -8, rotation: -10 }, { autoAlpha: 1, y: 0, rotation: 0, duration: 0.34, stagger: 0.05, ease: "back.out(1.8)", overwrite: "auto" });
      if (faces.length) gsap.fromTo(faces, { rotation: -180, scale: 0.72 }, { rotation: 0, scale: 1, duration: 0.5, stagger: 0.04, ease: "elastic.out(1, 0.55)", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [incomeRollSignature, incomeRollsOpen], revertOnUpdate: true }
  );

  useGSAP(
    () => {
      if (!view || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const logItems = scopedTargets(".public-log-list p:first-child");
      const miniCards = scopedTargets(".mini-card");
      if (logItems.length) gsap.fromTo(logItems, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.2, ease: "power2.out", overwrite: "auto" });
      if (miniCards.length) gsap.fromTo(miniCards, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.22, stagger: 0.02, ease: "power2.out", overwrite: "auto" });
    },
    { scope: appRef, dependencies: [view?.log.at(-1), view?.self.hand.length, view?.self.events.length], revertOnUpdate: true }
  );

  const call = <T,>(event: keyof ClientToServerEvents, payload: unknown) => {
    const socket = socketRef.current;
    if (!socket) return;
    // 防重复点击：同一事件未响应时忽略后续
    if (pendingActions.has(event as string)) return;
    setError("");
    setPendingActions((prev) => new Set(prev).add(event as string));
    (socket.emit as unknown as (
      event: string,
      payload: unknown,
      ack: (response: Ack<T & { view?: PlayerView; sessionToken?: string }>) => void
    ) => void)(event, payload, (response) => {
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(event as string);
        return next;
      });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      if (response.view) {
        const blackMarketNotice = buildBlackMarketPurchaseNotice(event, payload, view, response.view);
        setView(response.view);
        setConnectionStatus(socket.connected ? "connected" : "connecting");
        setError("");
        if (blackMarketNotice) enqueueNotice(blackMarketNotice);
      }
      if (response.sessionToken && response.view) {
        saveSession({
          roomId: response.view.roomId,
          playerId: response.view.selfId,
          sessionToken: response.sessionToken
        });
      }
    });
  };

  const createRoom = () => call<{ view: PlayerView; sessionToken: string }>("room:create", { nickname });
  const joinRoom = () => call<{ view: PlayerView; sessionToken: string }>("room:join", { nickname, joinCode });
  const resetSession = () => {
    clearSession();
    setView(undefined);
    setError("");
    setConnectionStatus(socketRef.current?.connected ? "connected" : "connecting");
  };
  const updateJoinCode = (value: string) => setJoinCode(value.replace(/\D/g, "").slice(0, 4));

  if (!view) {
    return (
      <main className="entry-screen">
        <section className="entry-panel">
          <div>
            <p className="eyebrow">Online MVP</p>
            <h1>拍卖师法则</h1>
            <p className="intro">实时好友房，轮流主持、竞拍奇珍、终局翻牌。</p>
          </div>
          <label>
            昵称
            <input value={nickname} maxLength={16} onChange={(event) => setNickname(event.target.value)} />
          </label>
          <div className="entry-actions">
            <button className="primary" onClick={createRoom}>
              <Gavel size={18} /> 创建房间
            </button>
          </div>
          <div className="join-row">
            <input
              placeholder="4位房间码"
              inputMode="numeric"
              maxLength={4}
              value={joinCode}
              onChange={(event) => updateJoinCode(event.target.value)}
            />
            <button onClick={joinRoom}>
              <Play size={18} /> 加入
            </button>
          </div>
          {connectionStatus === "recovering" && <p className="status-text">正在恢复上一局...</p>}
          {connectionStatus === "disconnected" && <p className="status-text">连接已断开，正在等待重连。</p>}
          {connectionStatus === "failed" && <button onClick={resetSession}>清除旧会话</button>}
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell ${view.paused ? "is-paused" : ""}`} ref={appRef}>
      <header className="topbar motion-panel">
        <div className="room-code">
          <span>房间码</span>
          <strong>{view.joinCode}</strong>
        </div>
        <div className="phase-chip">
          <strong>游戏天数</strong>
          <span>第 {view.day || 0}/{view.maxDays} 天</span>
        </div>
        <PhaseTimer view={view} now={now} />
        <div className="host-chip">
          <span>当前主持人</span>
          <strong>{view.players.find((player) => player.id === view.currentHostId)?.nickname ?? "系统"}</strong>
        </div>
        {connectionStatus !== "connected" && <div className={`connection-pill ${connectionStatus}`}>{connectionLabel(connectionStatus)}</div>}
        <div className="top-actions">
          {view.phase === "lobby" && (
            <>
              <button onClick={() => call("player:ready", { ready: !view.self.ready })}>
                <Check size={18} /> {view.self.ready ? "取消准备" : "准备"}
              </button>
              <button className="primary" disabled={!view.canStart} onClick={() => call("room:start", {})}>
                <Play size={18} /> 开始
              </button>
            </>
          )}
          {view.canAdvance && (
            <button className="primary" onClick={() => call("phase:advance", {})}>
              <RefreshCw size={18} /> 推进阶段
            </button>
          )}
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="设置">
            <Settings size={18} />
          </button>
        </div>
      </header>

      <section className="play-screen">
        <aside className="left-rail motion-panel">
          <RoleSkillsPanel view={view} call={call} openTargetRequest={setTargetRequest} />
        </aside>

        <section className="table-zone motion-panel">
          {view.paused && <div className="pause-banner"><Pause size={18} /> 房间已暂停</div>}
          {error && <div className="error-bar">{error}</div>}
          <div className="table-workbench">
            <ControlPanel
              view={view}
              bidAmount={bidAmount}
              dutchStepAmount={dutchStepAmount}
              sealedAmount={sealedAmount}
              setBidAmount={setBidAmount}
              setDutchStepAmount={setDutchStepAmount}
              setSealedAmount={setSealedAmount}
              call={call}
            />
            <ArtifactBoard artifacts={tableArtifacts} currentArtifact={currentArtifact} />
            <PublicPool view={view} currentArtifact={currentArtifact} />
          </div>
          <DiceRollPanel view={view} visible={incomeRollsOpen} />
          <ActiveEffectsPanel view={view} />
          <AutomationNotice view={view} now={now} />
        </section>

        <aside className="right-rail motion-panel">
          <SelfPanel
            view={view}
            call={call}
            openLoanConfirm={() => setLoanConfirmOpen(true)}
            openCardVault={setCardVaultOpen}
          />
          <LogPanel title="我的操作" icon={<History size={16} />} log={view.privateLog} emptyText="还没有私密操作。" />
        </aside>
      </section>

      {scoreboardOpen && <ScoreboardOverlay view={view} />}
      {backpackOpen && (
        <BackpackOverlay
          view={view}
          call={call}
          onClose={() => setBackpackOpen(false)}
          onSellArtifact={(artifactId) => setSellConfirmArtifactId(artifactId)}
        />
      )}
      {cardVaultOpen && (
        <CardVaultOverlay
          view={view}
          kind={cardVaultOpen}
          currentArtifact={currentArtifact}
          onClose={() => setCardVaultOpen(undefined)}
          setKind={setCardVaultOpen}
          openTargetRequest={setTargetRequest}
          openConfirmCard={setConfirmCard}
        />
      )}
      <TradeOfferModal view={view} call={call} />
      {notice && <NoticeModal notice={notice} onClose={closeNotice} />}
      {loanConfirmOpen && (
        <LoanConfirmModal
          view={view}
          onClose={() => setLoanConfirmOpen(false)}
          onConfirm={() => {
            setLoanConfirmOpen(false);
            call("loan:take", {});
          }}
        />
      )}
      {sellConfirmArtifactId && (
        <SellConfirmModal
          view={view}
          artifactId={sellConfirmArtifactId}
          onClose={() => setSellConfirmArtifactId(undefined)}
          onConfirm={() => {
            const artifactId = sellConfirmArtifactId;
            setSellConfirmArtifactId(undefined);
            call("bank:sell", { artifactId });
          }}
        />
      )}
      {roleRevealOpen && <RoleRevealModal view={view} onClose={() => setRoleRevealOpen(false)} />}
      {projectionOpen && view && view.projectedScore && <ProjectionPanel view={view} />}
      {settingsOpen && <SettingsModal view={view} call={call} onClose={() => setSettingsOpen(false)} bgm={bgm} />}
      {choiceEffect && (
        <PendingChoiceModal
          view={view}
          effect={choiceEffect}
          call={call}
          onDismiss={() => {
            setDismissedChoiceIds((current) => [...new Set([...current, choiceEffect.id])]);
            setChoiceEffect(undefined);
          }}
        />
      )}
      {confirmCard && (
        <CardConfirmModal
          card={confirmCard}
          onClose={() => setConfirmCard(undefined)}
          onConfirm={() => {
            const cardId = confirmCard.id;
            setConfirmCard(undefined);
            call("card:play", { cardId });
          }}
        />
      )}
      {targetRequest && (
        <TargetModal
          view={view}
          request={targetRequest}
          currentArtifact={currentArtifact}
          onClose={() => setTargetRequest(undefined)}
          onConfirm={(event, payload) => {
            setTargetRequest(undefined);
            call(event, payload);
          }}
        />
      )}
    </main>
  );
}

function PhaseTimer({ view, now }: { view: PlayerView; now: number }) {
  if (!view.phaseDeadlineAt || !view.phaseTimeoutMs) return null;
  const remainingMs = Math.max(0, view.phaseDeadlineAt - now);
  const totalMs = Math.max(1, view.phaseTimeoutMs);
  const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
  return (
    <div className={`timer-pill ${remainingMs <= 10_000 ? "urgent" : ""}`}>
      <div>
        <Timer size={16} />
        <strong>{formatRemaining(remainingMs)}</strong>
      </div>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function RoomAdminPanel({ view, call }: { view: PlayerView; call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void }) {
  const [targetId, setTargetId] = useState(view.players.find((player) => player.id !== view.selfId)?.id ?? "");
  const [timeoutSecondsByPhase, setTimeoutSecondsByPhase] = useState<Record<string, number>>(() => timeoutSecondsFromView(view));
  const target = targetId || view.players.find((player) => player.id !== view.selfId)?.id || "";

  useEffect(() => {
    setTimeoutSecondsByPhase(timeoutSecondsFromView(view));
  }, [view.phaseTimeouts]);

  const updateTimeout = (phase: GamePhase, value: number) => {
    setTimeoutSecondsByPhase((current) => ({ ...current, [phase]: Number.isFinite(value) ? value : 0 }));
  };
  const timeoutPayload: PhaseTimeouts = Object.fromEntries(
    configurableTimeoutPhases.map((phase) => [phase, Math.max(0, Math.floor(timeoutSecondsByPhase[phase] ?? 0)) * 1000])
  ) as PhaseTimeouts;

  return (
    <div className="panel admin-panel">
      <h3>房主管理</h3>
      <label>
        目标玩家
        <select value={target} onChange={(event) => setTargetId(event.target.value)}>
          {view.players
            .filter((player) => player.id !== view.selfId)
            .map((player) => (
              <option key={player.id} value={player.id}>
                {player.nickname}{player.connected ? "" : "（离线）"}
              </option>
            ))}
        </select>
      </label>
      <div className="admin-actions">
        <button disabled={!target} onClick={() => call("room:transferOwner", { playerId: target })}>
          <Crown size={18} /> 转让
        </button>
        <button disabled={!target} onClick={() => call("room:kick", { playerId: target })}>
          <UserMinus size={18} /> 踢出
        </button>
      </div>
      <div className="timeout-grid">
        {configurableTimeoutPhases.map((phase) => (
          <label key={phase}>
            {phaseLabels[phase]}
            <input
              type="number"
              min={0}
              max={1800}
              step={10}
              value={timeoutSecondsByPhase[phase] ?? 0}
              onChange={(event) => updateTimeout(phase, Number(event.target.value))}
            />
          </label>
        ))}
      </div>
      <button onClick={() => call("room:setTimeouts", { timeouts: timeoutPayload })}>
        <Timer size={18} /> 应用阶段配置
      </button>
    </div>
  );
}

function timeoutSecondsFromView(view: PlayerView): Record<string, number> {
  return Object.fromEntries(
    configurableTimeoutPhases.map((phase) => {
      const ms = view.phaseTimeouts?.[phase] ?? (phase === "freeTrade" ? 180_000 : phase === "settlement" || phase === "eventWindow" ? 90_000 : 120_000);
      return [phase, Math.round(ms / 1000)];
    })
  );
}

function AutomationNotice({ view, now }: { view: PlayerView; now: number }) {
  const automated = view.players.filter((player) => player.id !== view.selfId && player.automatedAt && now - player.automatedAt < 60_000);
  const selfAutomated = view.self.automatedAt && now - view.self.automatedAt < 60_000 ? view.self : undefined;
  if (automated.length === 0 && !selfAutomated) return null;
  return (
    <section className="panel automation-panel">
      <h3>托管提示</h3>
      {selfAutomated && <p>你离线期间系统已托管：{selfAutomated.automatedReason ?? "自动操作"}。</p>}
      {automated.map((player) => (
        <p key={player.id}>{player.nickname} 已由系统托管：{player.automatedReason ?? "自动操作"}。</p>
      ))}
    </section>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function connectionLabel(status: "connecting" | "connected" | "disconnected" | "recovering" | "failed"): string {
  if (status === "connecting") return "正在连接";
  if (status === "recovering") return "正在恢复";
  if (status === "disconnected") return "连接断开";
  if (status === "failed") return "连接异常";
  return "已连接";
}

function ActiveEffectsPanel({ view }: { view: PlayerView }) {
  if (view.activeEffects.length === 0) return null;
  return (
    <section className="panel effects-panel">
      <h3>生效效果</h3>
      {view.activeEffects.map((effect) => (
        <p key={effect.id}>{effect.label}</p>
      ))}
    </section>
  );
}

function PendingChoiceModal({
  view,
  effect,
  call,
  onDismiss
}: {
  view: PlayerView;
  effect: ActiveEffect;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const choose = (choice: ChoiceResolution) => {
    if (busy) return;
    setBusy(true);
    call("choice:resolve", { effectId: effect.id, choice });
  };
  const artifactName = effect.targetArtifactId ? findArtifactName(view, effect.targetArtifactId) : "目标藏品";
  const options = choiceOptionsForEffect(effect);
  const title = choiceTitleForEffect(effect);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal compact-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">待选择</p>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onDismiss} aria-label="稍后再处理">
            <X size={18} />
          </button>
        </header>
        <p style={{ padding: "0 1rem 1rem", textAlign: "center" }}>
          {effect.label.replace("目标藏品", artifactName)}
        </p>
        <div style={{ display: "flex", gap: "1rem", justifyContent: "center", padding: "0 1rem 1.5rem" }}>
          {options.map((option) => (
            <button className={option.primary ? "bids-button primary" : "bids-button"} disabled={busy} onClick={() => choose(option.choice)} key={option.choice}>
              {option.label}
            </button>
          ))}
          <button className="bids-button" disabled={busy} onClick={onDismiss}>
            稍后
          </button>
        </div>
      </section>
    </div>
  );
}

function choiceTitleForEffect(effect: ActiveEffect): string {
  if (effect.choiceType === "role03_skill02_swap") return "以物换物";
  if (effect.choiceType === "role01_skill01_choice") return "慧眼";
  if (effect.choiceType === "E25_protection_fee") return "灵异恐惧";
  if (effect.choiceType === "n1_mystery_buyer") return "神秘收购";
  if (effect.choiceType === "C03_buyback") return "回购凭证";
  if (effect.choiceType === "C04_listing") return "寄售单";
  if (effect.choiceType === "D02_refusal") return "巧取豪夺";
  if (effect.choiceType === "prop31_donation") return "慈善捐赠";
  return "选择";
}

function choiceOptionsForEffect(effect: ActiveEffect): Array<{ choice: ChoiceResolution; label: string; primary?: boolean }> {
  if (effect.choiceType === "role01_skill01_choice") {
    return [
      { choice: "rumorRange", label: "传闻区间", primary: true },
      { choice: "attribute", label: "属性" }
    ];
  }
  if (effect.choiceType === "E25_protection_fee") {
    return [
      { choice: "pay", label: "支付保护费", primary: true },
      { choice: "accept", label: "接受 -20%" }
    ];
  }
  if (effect.choiceType === "n1_mystery_buyer") {
    return [
      { choice: "sell", label: "卖出藏品", primary: true },
      { choice: "reject", label: "拒绝得声望" }
    ];
  }
  if (effect.choiceType === "C03_buyback") {
    return [
      { choice: "accept", label: "买回", primary: true },
      { choice: "reject", label: "放弃" }
    ];
  }
  if (effect.choiceType === "C04_listing") return [{ choice: "accept", label: `购买 ${effect.amount ?? ""} 银元`, primary: true }];
  if (effect.choiceType === "D02_refusal") {
    return [
      { choice: "pay", label: "支付 20", primary: true },
      { choice: "reveal", label: "展示属性" }
    ];
  }
  if (effect.choiceType === "prop31_donation") {
    return [
      { choice: "accept", label: "捐赠弃置", primary: true },
      { choice: "reject", label: "保留藏品" }
    ];
  }
  if (effect.choiceType === "role03_skill02_swap") {
    return [
      { choice: "accept", label: "同意交换", primary: true },
      { choice: "reject", label: "拒绝" }
    ];
  }
  return [{ choice: "accept", label: "确认", primary: true }];
}

function PlayerList({ view }: { view: PlayerView }) {
  return (
    <div className="panel">
      <h3>玩家</h3>
      <div className="player-list">
        {view.players.map((player) => (
          <div className="player-row" key={player.id}>
            <div>
              <strong>{player.nickname}</strong>
              <span>{playerStatusLabel(player)}</span>
            </div>
            <div className="player-stats">
              <span><Coins size={14} /> {player.cash}</span>
              <span><Scale size={14} /> {player.artifactCount}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreboardOverlay({ view }: { view: PlayerView }) {
  const sorted = [...view.players].sort((a, b) => (a.id === view.selfId ? -1 : b.id === view.selfId ? 1 : a.seat - b.seat));
  const missions = view.self.missions.length ? view.self.missions : view.self.mission ? [view.self.mission] : [];
  return (
    <div className="scoreboard-layer" aria-label="玩家信息">
      <section className="scoreboard-panel">
        <header>
          <div>
            <p className="eyebrow">Tab</p>
            <h3>玩家信息</h3>
          </div>
          <span>松开 Tab 关闭</span>
        </header>
        <div className="scoreboard-grid">
          {sorted.map((player) => (
            <article className={`scoreboard-row ${player.id === view.selfId ? "self" : ""}`} key={player.id}>
              <div>
                <strong>{player.nickname}{player.id === view.selfId ? " · 你" : ""}</strong>
                <span>{player.roleName ?? "未分配角色"}</span>
              </div>
              <span>{playerStatusLabel(player)}</span>
              <span><Coins size={15} /> {player.cash}</span>
              <span><Scale size={15} /> {player.artifactCount}</span>
              <span><ScrollText size={15} /> {player.handCount}</span>
              <span><BookOpen size={15} /> {player.eventCount}</span>
            </article>
          ))}
        </div>
        <section className="scoreboard-missions" aria-label="我的秘密委托">
          <header>
            <p className="eyebrow">我的秘密委托</p>
            <span>仅自己可见</span>
          </header>
          <div className="mission-strip">
            {missions.length === 0 && <p className="empty-text">开局后会显示你的委托。</p>}
            {missions.map((mission) => (
              <article className="mission-item compact" key={mission.id}>
                <p>{mission.name}</p>
                <strong className="mission-reward">完成奖励 +{mission.reputation} 声望</strong>
                <small>{mission.description}</small>
              </article>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}

function RoleRevealModal({ view, onClose }: { view: PlayerView; onClose: () => void }) {
  const role = view.self.role;
  if (!role) return null;
  const rolePortrait = getRolePortrait(role.id);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal role-reveal-modal" role="dialog" aria-modal="true" aria-label="角色揭示">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">角色揭示</p>
            <h3>恭喜你抽到了 {role.name}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="role-reveal-body">
          {rolePortrait && (
            <div className="role-reveal-art">
              <img src={rolePortrait} alt={`${role.name} role portrait`} draggable={false} decoding="async" loading="eager" />
            </div>
          )}
          <div className="role-reveal-skills">
            {role.skills.map((skill) => (
              <div className="mini-card" key={skill.id}>
                <strong>{skill.name} · {skill.kind}</strong>
                <span>{skill.effectText}</span>
              </div>
            ))}
          </div>
        </div>
        <footer className="target-actions">
          <button className="primary" onClick={onClose}>
            <Check size={18} /> 知道了
          </button>
        </footer>
      </section>
    </div>
  );
}

function RoleSkillsPanel({
  view,
  call,
  openTargetRequest
}: {
  view: PlayerView;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  openTargetRequest: (request: TargetRequest) => void;
}) {
  const role = view.self.role;
  const rolePortrait = getRolePortrait(role?.id);
  return (
    <section className="panel role-skill-panel">
      <div>
        <p className="eyebrow">角色</p>
        <h3>{role?.name ?? view.self.roleName ?? "未分配角色"}</h3>
      </div>
      {rolePortrait && role && (
        <div className="role-panel-art">
          <img src={rolePortrait} alt={`${role.name} role portrait`} draggable={false} decoding="async" loading="eager" />
        </div>
      )}
      {role ? (
        <div className="role-skill-grid">
          {role.skills.map((skill) => (
            <article className="role-skill-card" key={skill.id}>
              <strong>{skill.name} · {skill.kind}</strong>
              <small>{skill.timing || "时机未标注"}</small>
              <span>{skill.effectText}</span>
              {((skill.kind === "主动" && skill.id !== "role05_skill01") || skill.id === "role05_skill02") && (
                <button
                  data-target-mode={targetModeForRoleSkill(skill.id)}
                  disabled={!canUseRoleSkillFromView(view, skill)}
                  onClick={() =>
                    targetModeForRoleSkill(skill.id) === "none"
                      ? call("role:skill", { skillId: skill.id })
                      : openTargetRequest({ kind: "role", skill })
                  }
                >
                  <Eye size={18} /> 使用
                </button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-text">开局后会显示你的角色和技能。</p>
      )}
    </section>
  );
}

function playerStatusLabel(player: PlayerView["players"][number]): string {
  if (player.kicked) return "已移出";
  const role = player.isHost ? "主持人" : player.ready ? "已准备" : "等待";
  return player.connected ? role : `${role} · 离线`;
}

function ControlPanel({
  view,
  bidAmount,
  dutchStepAmount,
  sealedAmount,
  setBidAmount,
  setDutchStepAmount,
  setSealedAmount,
  call
}: {
  view: PlayerView;
  bidAmount: number;
  dutchStepAmount: number;
  sealedAmount: number;
  setBidAmount: (value: number) => void;
  setDutchStepAmount: (value: number) => void;
  setSealedAmount: (value: number) => void;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
}) {
  const counterCards = view.self.hand.filter((card) => card.category?.includes("反制"));
  const counterSignature = counterCards.map((card) => card.id).join("|");
  const [counterCardId, setCounterCardId] = useState(counterCards[0]?.id ?? "");
  const [redirectTargetId, setRedirectTargetId] = useState("");
  const selectedCounterCardId = counterCards.some((card) => card.id === counterCardId) ? counterCardId : counterCards[0]?.id ?? "";
  const redirectTargets = view.players.filter((player) => player.id !== view.selfId && player.id !== view.pendingReaction?.sourcePlayerId);
  const isHostChoosingStartBid = view.phase === "cardWindow" && view.currentHostId === view.selfId && view.auction?.status === "choosing";
  const auctionBidMode = view.auction?.mode === "bundle" ? view.auction.bundleInnerMode ?? "english" : view.auction?.mode;
  const activeAuctionIds = view.auction?.mode === "bundle" ? (view.auction?.artifactIds ?? []) : view.auction?.artifactIds?.slice(view.auction.currentArtifactIndex, view.auction.currentArtifactIndex + 1) ?? [];
  const activeArtifacts =
    activeAuctionIds.length > 0 ? view.todayArtifacts.filter((artifact) => activeAuctionIds.includes(artifact.id)) : [];
  const startBidCeiling = activeArtifacts.reduce((sum, artifact) => sum + (artifact.rumorMax ?? 0), 0);

  useEffect(() => {
    setCounterCardId((current) => (counterCards.some((card) => card.id === current) ? current : counterCards[0]?.id ?? ""));
  }, [counterSignature]);

  useEffect(() => {
    setRedirectTargetId((current) => (redirectTargets.some((player) => player.id === current) ? current : redirectTargets[0]?.id ?? ""));
  }, [view.pendingReaction?.id, redirectTargets.map((player) => player.id).join("|")]);

  useEffect(() => {
    if (isHostChoosingStartBid && typeof view.auction?.currentBid === "number") {
      setBidAmount(view.auction.currentBid);
    }
    if (isHostChoosingStartBid && typeof view.auction?.dutchStep === "number") {
      setDutchStepAmount(view.auction.dutchStep);
    }
  }, [isHostChoosingStartBid, view.auction?.id, view.auction?.currentBid, view.auction?.dutchStep, setBidAmount, setDutchStepAmount]);

  if (view.phase === "finalScoring") return <FinalScores view={view} />;

  return (
    <section className="panel action-panel">
      <div>
        <p className="eyebrow">行动</p>
        <h3>{view.lastMessage ?? "等待玩家操作"}</h3>
      </div>

      {view.pendingReaction && (
        <div className="reaction-strip">
          <strong>反制窗口已打开</strong>
          {counterCards.length > 1 && (
            <select value={selectedCounterCardId} onChange={(event) => setCounterCardId(event.target.value)} aria-label="选择反制牌">
              {counterCards.map((card, index) => (
                <option value={card.id} key={`${card.id}-${index}`}>{card.name}</option>
              ))}
            </select>
          )}
          {selectedCounterCardId === "R05" && (
            <select value={redirectTargetId} onChange={(event) => setRedirectTargetId(event.target.value)} aria-label="转移目标">
              {redirectTargets.map((player) => (
                <option value={player.id} key={player.id}>{player.nickname}</option>
              ))}
            </select>
          )}
          <button
            className="primary"
            disabled={!selectedCounterCardId || (selectedCounterCardId === "R05" && !redirectTargetId)}
            onClick={() =>
              call("reaction:respond", {
                reactionId: view.pendingReaction?.id,
                cardId: selectedCounterCardId,
                targetPlayerId: selectedCounterCardId === "R05" ? redirectTargetId : undefined,
                response: "counter"
              })
            }
          >
            <ShieldCheck size={18} /> 反制
          </button>
          <button onClick={() => call("reaction:respond", { reactionId: view.pendingReaction?.id, response: "pass" })}>
            <X size={18} /> 放弃
          </button>
        </div>
      )}

      {view.phase === "blackMarket" && (
        <div className="button-grid">
          <button onClick={() => call("blackMarket:buy", { kind: "trick" })}>
            <ShoppingBag size={18} /> 买锦囊 30
          </button>
          <button onClick={() => call("blackMarket:buy", { kind: "event" })}>
            <ShoppingBag size={18} /> 买事件 50
          </button>
        </div>
      )}

      {view.phase === "preview" && (
        <div className="hint-strip">
          <Gavel size={18} />
          <span>推进后系统会随机生成今日拍卖方式。</span>
        </div>
      )}

      {(view.phase === "cardWindow" || view.phase === "eventWindow") && (
        <div className="hint-strip">
          <ShieldCheck size={18} />
          <span>可在右侧锦囊/事件卡区选择手牌，确认后再使用。</span>
        </div>
      )}

      {isHostChoosingStartBid && (
        <div className="auction-controls">
          <strong>
            主持人设置起拍价
            {auctionBidMode === "dutch" ? "（荷兰式起拍）" : auctionBidMode === "sealed" ? "（暗标无需设置）" : ""}
          </strong>
          {auctionBidMode === "sealed" ? (
            <small>暗标拍卖不公开起拍价，直接推进即可。</small>
          ) : (
            <>
              <label>
                起拍价（银元）
                <input type="number" min={0} step={10} value={bidAmount} onChange={(event) => setBidAmount(Number(event.target.value))} />
              </label>
              {auctionBidMode === "dutch" && (
                <label>
                  降价幅度（银元，必须是10的整数倍）
                  <input type="number" min={10} step={10} value={dutchStepAmount} onChange={(event) => setDutchStepAmount(Number(event.target.value))} />
                </label>
              )}
              <small>上限 {startBidCeiling} 银元</small>
              <button className="primary" onClick={() => call("host:setAuction", { startingBid: bidAmount, dutchStep: auctionBidMode === "dutch" ? dutchStepAmount : undefined })}>
                <Gavel size={18} /> 确认起拍价
              </button>
            </>
          )}
        </div>
      )}

      {view.phase === "auction" && auctionBidMode === "english" && (
        <div className="auction-controls">
          <strong>当前价：{view.auction?.currentBid ?? 0}</strong>
          {view.auction?.bidDeadline && (
            <div className="bid-timer">
              <span className={view.auction.bidDeadline - Date.now() <= 10000 ? "urgent" : ""}>
                剩余 {Math.max(0, Math.ceil((view.auction.bidDeadline - Date.now()) / 1000))} 秒
              </span>
              <progress value={Math.max(0, view.auction.bidDeadline - Date.now())} max={15000} />
            </div>
          )}
          <input type="number" value={bidAmount} onChange={(event) => setBidAmount(Number(event.target.value))} />
          <button className="primary" onClick={() => call("bid:place", { amount: bidAmount })}>
            <Gavel size={18} /> 出价
          </button>
          <button onClick={() => call("bid:pass", {})}>退出</button>
        </div>
      )}

      {view.phase === "auction" && auctionBidMode === "dutch" && (
        <div className="auction-controls">
          <strong ref={(el) => {
            // GSAP bounce on price change
            if (el && view.auction?.dutch?.currentPrice !== undefined) {
              const prev = el.dataset.price;
              const curr = String(view.auction.dutch.currentPrice);
              if (prev && prev !== curr && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                gsap.fromTo(el.querySelector(".dutch-price") ?? el, { scale: 1.25, color: "#2e7568" }, { scale: 1, color: "", duration: 0.35, ease: "back.out(2.5)", overwrite: "auto" });
              }
              el.dataset.price = curr;
            }
          }}>
            <span className="dutch-price">当前荷兰价：{view.auction?.dutch?.currentPrice ?? view.auction?.currentBid ?? 0} 银元</span>
          </strong>
          {view.auction?.dutch && <DutchTimer dutch={view.auction.dutch} />}
          <button className="primary" onClick={() => call("dutch:stop", {})}>
            <Gavel size={18} /> 喊停
          </button>
        </div>
      )}

      {view.phase === "auction" && auctionBidMode === "sealed" && (
        <div className="auction-controls">
          <strong>暗标已提交：{view.auction?.sealedSubmittedPlayerIds.length ?? 0}</strong>
          {view.auction?.visibleSealedBids && (
            <small>{Object.entries(view.auction.visibleSealedBids).map(([playerId, amount]) => `${view.players.find((player) => player.id === playerId)?.nickname ?? playerId}:${amount}`).join(" / ")}</small>
          )}
          <input type="number" value={sealedAmount} onChange={(event) => setSealedAmount(Number(event.target.value))} />
          <button className="primary" onClick={() => call("sealedBid:submit", { amount: sealedAmount })}>
            <BadgeCheck size={18} /> 提交暗标
          </button>
        </div>
      )}

      {view.phase === "freeTrade" && <TradePanel view={view} call={call} />}
    </section>
  );
}

function DiceRollPanel({ view, visible }: { view: PlayerView; visible: boolean }) {
  const rolls = view.lastIncomeRolls;
  if (!visible || !rolls?.length) return null;
  return (
    <section className="panel dice-panel" aria-label="晨间掷骰结果">
      <div>
        <p className="eyebrow">晨间收入</p>
        <h3>掷骰结果</h3>
      </div>
      <div className="dice-grid">
        {rolls.map((roll) => (
          <article className={`dice-card ${roll.playerId === view.selfId ? "self" : ""}`} key={roll.playerId}>
            <DiceFace value={roll.roll} />
            <div>
              <strong>{roll.nickname}</strong>
              <span>{roll.reroll === undefined ? `掷出 ${roll.roll}` : `初掷 ${roll.roll}，重掷 ${roll.reroll}，取高`}</span>
              <b>+{roll.amount} 银元</b>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DiceFace({ value }: { value: number }) {
  const dots = diceDots[Math.max(1, Math.min(6, value))] ?? diceDots[1]!;
  return (
    <span className="dice-face" aria-label={`${value} 点`}>
      {dots.map((dot) => (
        <i key={dot} className={`dot dot-${dot}`} />
      ))}
    </span>
  );
}

const diceDots: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9]
};

function ArtifactBoard({ artifacts, currentArtifact }: { artifacts: PublicArtifactView[]; currentArtifact?: PublicArtifactView }) {
  return (
    <section className="artifact-grid">
      {artifacts.length === 0 && (
        <div className="table-empty-state">
          <Gavel size={56} strokeWidth={1.5} />
          <h3>暂无待拍商品</h3>
          <p>预展阶段后将显示今日拍品</p>
        </div>
      )}
      {artifacts.map((artifact) => (
        <article className={`artifact-card ${artifact.id === currentArtifact?.id ? "current" : ""}`} key={artifact.id}>
          <span>{artifact.series ?? "未知系列"}</span>
          <h3>{artifact.name}</h3>
          <p>{artifact.category ? CATEGORY_LABELS[artifact.category] : "类别隐藏"}</p>
          <p>{artifact.rumorMin === undefined ? "传闻区间隐藏" : `${artifact.rumorMin} - ${artifact.rumorMax} 银元`}</p>
          <p>到手价（成交价）：{artifact.purchasePrice ?? "未成交"}{artifact.purchasePrice === undefined ? "" : " 银元"}</p>
          <p>{artifact.tag ? TAG_LABELS[artifact.tag] : "标签隐藏"}</p>
          {artifact.story && <small>{artifact.story}</small>}
        </article>
      ))}
    </section>
  );
}

function TradePanel({ view, call }: { view: PlayerView; call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void }) {
  const otherPlayers = view.players.filter((player) => player.id !== view.selfId);
  const [targetId, setTargetId] = useState("");
  const [mode, setMode] = useState<"buy" | "sell" | "swap">("buy");
  const [price, setPrice] = useState(0);
  const [artifactId, setArtifactId] = useState("");
  const targetPlayerId = targetId || otherPlayers[0]?.id;
  const selectedTarget = view.players.find((player) => player.id === targetPlayerId);
  const artifactOptions = mode === "buy" ? selectedTarget?.artifacts ?? [] : view.self.artifacts;
  const selectedArtifactId = artifactOptions.some((artifact) => artifact.id === artifactId) ? artifactId : artifactOptions[0]?.id ?? "";
  const targetArtifactOptions = mode === "swap" ? selectedTarget?.artifacts ?? [] : [];
  const [targetArtifactId, setTargetArtifactId] = useState(targetArtifactOptions[0]?.id ?? "");
  const selectedTargetArtifactId = targetArtifactOptions.some((artifact) => artifact.id === targetArtifactId) ? targetArtifactId : targetArtifactOptions[0]?.id ?? "";
  const nameOf = (playerId: string) => view.players.find((player) => player.id === playerId)?.nickname ?? "玩家";

  useEffect(() => {
    setArtifactId((current) => (artifactOptions.some((artifact) => artifact.id === current) ? current : artifactOptions[0]?.id ?? ""));
  }, [mode, targetPlayerId, artifactOptions]);

  useEffect(() => {
    setTargetArtifactId((current) => (targetArtifactOptions.some((artifact) => artifact.id === current) ? current : targetArtifactOptions[0]?.id ?? ""));
  }, [targetPlayerId, targetArtifactOptions]);

  return (
    <div className="trade-panel">
      <div className="trade-header">
        <strong>自由交易</strong>
        <span className="trade-count">今日交易：{view.self.tradesToday ?? 0} / 3</span>
      </div>
      <div className="trade-builder">
        <label className="trade-step-card">
          1. 选择玩家
          <select value={targetPlayerId ?? ""} onChange={(event) => setTargetId(event.target.value)}>
            {otherPlayers.map((player) => (
              <option key={player.id} value={player.id}>{player.nickname}</option>
            ))}
          </select>
        </label>
        <div className="trade-step-card">
          <span>2. 交易方向</span>
          <div className="segmented-control">
            <button className={mode === "buy" ? "selected" : ""} onClick={() => setMode("buy")}>买入</button>
            <button className={mode === "sell" ? "selected" : ""} onClick={() => setMode("sell")}>卖出</button>
            <button className={mode === "swap" ? "selected" : ""} onClick={() => setMode("swap")}>换物</button>
          </div>
        </div>
        <label className="trade-step-card">
          3. {mode === "buy" ? "选择想买的商品" : mode === "sell" ? "选择想卖的商品" : "选择你要拿出的商品"}
          <select value={selectedArtifactId} onChange={(event) => setArtifactId(event.target.value)}>
            {artifactOptions.length === 0 && <option value="">没有可交易藏品</option>}
            {artifactOptions.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>{artifact.name}</option>
            ))}
          </select>
        </label>
        {mode === "swap" ? (
          <label className="trade-step-card">
            4. 选择对方藏品
            <select value={selectedTargetArtifactId} onChange={(event) => setTargetArtifactId(event.target.value)}>
              {targetArtifactOptions.length === 0 && <option value="">对方没有可交换藏品</option>}
              {targetArtifactOptions.map((artifact) => (
                <option key={artifact.id} value={artifact.id}>{artifact.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <label className="trade-step-card">
            4. 输入价格
            <input type="number" min={0} value={price} onChange={(event) => setPrice(Number(event.target.value))} />
          </label>
        )}
        <button
          className="primary"
          disabled={
            (view.self.tradesToday ?? 0) >= 3 ||
            !targetPlayerId ||
            !selectedArtifactId ||
            (mode === "swap" ? !selectedTargetArtifactId : price <= 0)
          }
          onClick={() => {
            if (mode === "swap") {
              call("trade:offer", {
                toPlayerId: targetPlayerId,
                give: { artifactIds: [selectedArtifactId] },
                receive: { artifactIds: [selectedTargetArtifactId] },
                message: "swap"
              });
              return;
            }
            call("trade:offer", {
              toPlayerId: targetPlayerId,
              give: mode === "buy" ? { cash: price } : { artifactIds: [selectedArtifactId] },
              receive: mode === "buy" ? { artifactIds: [selectedArtifactId] } : { cash: price },
              message: mode === "buy" ? "buy" : "sell"
            });
          }}
        >
          <Handshake size={18} /> {mode === "swap" ? "发起换物" : "发起交易"}
        </button>
      </div>
      {view.tradeOffers.length > 0 && (
        <div className="trade-list">
          {view.tradeOffers.map((offer) => (
            <div className="trade-offer" key={offer.id}>
              <strong>{nameOf(offer.fromPlayerId)} → {nameOf(offer.toPlayerId)}</strong>
              <span>
                给 {formatTradeAssets(offer.give, view)} / 要 {formatTradeAssets(offer.receive, view)} · {tradeStatusLabel(offer.status)}
              </span>
              {offer.status === "pending" && offer.toPlayerId === view.selfId && (
                <div className="trade-actions">
                  <button className="primary" onClick={() => call("trade:respond", { tradeOfferId: offer.id, accept: true, version: offer.version })}>
                    <Check size={18} /> 接受
                  </button>
                  <button onClick={() => call("trade:respond", { tradeOfferId: offer.id, accept: false, version: offer.version })}>
                    <X size={18} /> 拒绝
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 荷兰式拍卖 5 秒倒计时进度条 */
function DutchTimer({ dutch }: { dutch: { nextDropAt: number; tickMs: number; step: number } }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, dutch.nextDropAt - Date.now()));
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const update = () => {
      const rem = Math.max(0, dutch.nextDropAt - Date.now());
      setRemaining(rem);
      // 如果超过 tickMs 都没有收到服务器广播，标记为不同步
      if (rem <= 0) {
        const timer = setTimeout(() => setStalled(true), 2000);
        return () => clearTimeout(timer);
      }
      setStalled(false);
    };
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [dutch.nextDropAt]);

  const seconds = Math.ceil(remaining / 1000);
  const progress = Math.min(1, remaining / dutch.tickMs);

  return (
    <div className="bid-timer">
      {stalled ? (
        <span className="urgent">同步中...</span>
      ) : (
        <span className={remaining <= 1000 ? "urgent" : ""}>
          {seconds} 秒后降价
        </span>
      )}
      <progress value={remaining} max={dutch.tickMs} />
    </div>
  );
}

function TradeOfferModal({ view, call }: { view: PlayerView; call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void }) {
  const offer = view.tradeOffers.find((candidate) => candidate.status === "pending" && candidate.toPlayerId === view.selfId);
  if (!offer) return null;
  const fromName = view.players.find((player) => player.id === offer.fromPlayerId)?.nickname ?? "玩家";
  return (
    <div className="modal-backdrop trade-offer-backdrop" role="presentation">
      <section className="target-modal compact-modal trade-offer-modal" role="dialog" aria-modal="true" aria-label="交易请求">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">交易请求</p>
            <h3>{fromName} 发来交易</h3>
          </div>
        </header>
        <div className="trade-offer-detail">
          <p>对方给你：<strong>{formatTradeAssets(offer.give, view)}</strong></p>
          <p>对方想要：<strong>{formatTradeAssets(offer.receive, view)}</strong></p>
        </div>
        <footer className="target-actions">
          <button onClick={() => call("trade:respond", { tradeOfferId: offer.id, accept: false, version: offer.version })}>
            <X size={18} /> 拒绝
          </button>
          <button className="primary" onClick={() => call("trade:respond", { tradeOfferId: offer.id, accept: true, version: offer.version })}>
            <Check size={18} /> 同意
          </button>
        </footer>
      </section>
    </div>
  );
}

function TargetModal({
  view,
  request,
  currentArtifact,
  onClose,
  onConfirm
}: {
  view: PlayerView;
  request: TargetRequest;
  currentArtifact?: PublicArtifactView;
  onClose: () => void;
  onConfirm: (event: keyof ClientToServerEvents, payload: unknown) => void;
}) {
  const mode = request.kind === "card" ? targetModeForCard(request.card) : request.kind === "consignment" ? "ownedArtifact" : targetModeForRoleSkill(request.skill.id);
  const otherPlayers = view.players.filter((player) => player.id !== view.selfId);
  const [targetPlayerId, setTargetPlayerId] = useState(otherPlayers[0]?.id ?? "");
  const artifactOptions =
    request.kind === "role" && mode === "ownedArtifact"
      ? uniqueArtifacts(ownedArtifactsEligibleForSkill(view, request.skill.id), currentArtifact?.id)
      : artifactTargetsFor(view, mode, request.kind === "card" ? request.defaultArtifactId : currentArtifact?.id, targetPlayerId);
  const [targetArtifactId, setTargetArtifactId] = useState(artifactOptions[0]?.id ?? "");
  const [price, setPrice] = useState(artifactOptions[0]?.purchasePrice ?? artifactOptions[0]?.rumorMin ?? 0);
  const missions = missionTargetsFor(view, targetPlayerId);
  const [targetMissionId, setTargetMissionId] = useState(missions[0]?.id ?? "");
  // 以物换物：自己的藏品
  const ownedArtifactOptions = view.self.artifacts;
  const [mySwapArtifactId, setMySwapArtifactId] = useState(ownedArtifactOptions[0]?.id ?? "");
  // 对方可供选择的藏品（以物换物用）
  const theirArtifactOptions = targetPlayerId
    ? view.players
        .find((p) => p.id === targetPlayerId)
        ?.artifacts?.filter((a) => a.ownerId === targetPlayerId) ?? []
    : [];
  const [theirSwapArtifactId, setTheirSwapArtifactId] = useState(theirArtifactOptions[0]?.id ?? "");

  useEffect(() => {
    setTargetPlayerId((current) => current || otherPlayers[0]?.id || "");
  }, [otherPlayers]);

  useEffect(() => {
    setTargetArtifactId((current) => (artifactOptions.some((artifact) => artifact.id === current) ? current : artifactOptions[0]?.id ?? ""));
    setPrice((current) => (Number.isFinite(current) && current > 0 ? current : artifactOptions[0]?.purchasePrice ?? artifactOptions[0]?.rumorMin ?? 0));
  }, [artifactOptions]);

  useEffect(() => {
    setTargetMissionId((current) => (missions.some((mission) => mission.id === current) ? current : missions[0]?.id ?? ""));
  }, [missions]);

  useEffect(() => {
    if (mode === "playerSwap") setTheirSwapArtifactId((current) => (theirArtifactOptions.some((a) => a.id === current) ? current : theirArtifactOptions[0]?.id ?? ""));
  }, [theirArtifactOptions]);

  const title = request.kind === "card" ? request.card.name : request.kind === "consignment" ? request.card.name : request.skill.name;
  const isSwap = mode === "playerSwap" && request.kind === "role";
  const isConsignment = request.kind === "consignment";
  const needsPlayer = mode === "player" || mode === "playerArtifact" || mode === "playerAuctionArtifact" || mode === "playerMission";
  const needsArtifact = mode === "artifact" || mode === "ownedArtifact" || mode === "playerArtifact" || mode === "playerAuctionArtifact";
  const needsMission = mode === "playerMission";
  const canConfirm = isSwap
    ? Boolean(targetPlayerId) && Boolean(mySwapArtifactId) && Boolean(theirSwapArtifactId)
    : isConsignment
      ? Boolean(targetArtifactId) && price > 0
      : (!needsPlayer || Boolean(targetPlayerId)) && (!needsArtifact || Boolean(targetArtifactId));
  const confirm = () => {
    if (!canConfirm) return;
    if (isSwap) {
      onConfirm("role:skill", {
        skillId: request.skill.id,
        targetPlayerId,
        targetArtifactId: mySwapArtifactId,
        targetMissionId: theirSwapArtifactId
      });
      return;
    }
    if (isConsignment) {
      onConfirm("card:play", {
        cardId: request.card.id,
        targetArtifactId,
        amount: price
      });
      return;
    }
    if (request.kind === "card") {
      onConfirm("card:play", {
        cardId: request.card.id,
        targetPlayerId: needsPlayer ? targetPlayerId : undefined,
        targetArtifactId: needsArtifact ? targetArtifactId : undefined
      });
      return;
    }
    onConfirm("role:skill", {
      skillId: request.skill.id,
      targetPlayerId: needsPlayer ? targetPlayerId : undefined,
      targetArtifactId: needsArtifact ? targetArtifactId : undefined,
      targetMissionId: needsMission && targetMissionId ? targetMissionId : undefined
    });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal" role="dialog" aria-modal="true" aria-label={`选择目标 ${title}`}>
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">选择目标</p>
            <h3>{title}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="target-grid">
          {needsPlayer && (
            <label>
              目标玩家
              <select value={targetPlayerId} onChange={(event) => setTargetPlayerId(event.target.value)}>
                {otherPlayers.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.nickname}
                  </option>
                ))}
              </select>
            </label>
          )}

          {needsArtifact && (
            <label>
              目标藏品
              <select value={targetArtifactId} onChange={(event) => setTargetArtifactId(event.target.value)}>
                {artifactOptions.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {artifact.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {isSwap && (
            <>
              <label>
                你的藏品
                <select value={mySwapArtifactId} onChange={(event) => setMySwapArtifactId(event.target.value)}>
                  {ownedArtifactOptions.map((artifact) => (
                    <option key={artifact.id} value={artifact.id}>
                      {artifact.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                目标玩家
                <select value={targetPlayerId} onChange={(event) => setTargetPlayerId(event.target.value)}>
                  {otherPlayers.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.nickname}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                对方的藏品
                <select value={theirSwapArtifactId} onChange={(event) => setTheirSwapArtifactId(event.target.value)}>
                  {theirArtifactOptions.map((artifact) => (
                    <option key={artifact.id} value={artifact.id}>
                      {artifact.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {request.kind === "role" && request.skill.id === "role06_skill03" && !isSwap && (
            <p className="target-hint">将消耗 50 银元查看该对手的两个秘密委托。</p>
          )}

          {isConsignment && (
            <label>
              寄售定价
              <input type="number" min={0} step={10} value={price} onChange={(event) => setPrice(Number(event.target.value))} />
            </label>
          )}

        </div>

        {needsArtifact && artifactOptions.length === 0 && <p className="target-empty">没有可选藏品。</p>}
        {needsPlayer && otherPlayers.length === 0 && <p className="target-empty">没有可选玩家。</p>}
        {isSwap && theirArtifactOptions.length === 0 && <p className="target-empty">对方没有可供交换的藏品。</p>}
        {isSwap && ownedArtifactOptions.length === 0 && <p className="target-empty">你没有可供交换的藏品。</p>}

        <footer className="target-actions">
          <button onClick={onClose}>
            <X size={18} /> 取消
          </button>
          <button className="primary" disabled={!canConfirm} onClick={confirm}>
            <Check size={18} /> 确认
          </button>
        </footer>
      </section>
    </div>
  );
}

function SelfPanel({
  view,
  call,
  openLoanConfirm,
  openCardVault
}: {
  view: PlayerView;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  openLoanConfirm: () => void;
  openCardVault: (kind: CardVaultKind) => void;
}) {
  return (
    <>
      <div className="panel card-command-panel">
        <div className="card-command-head">
          <h3>手牌</h3>
          <div className="resource-stack">
            <span><Coins size={15} /> {view.self.cash}</span>
            <span><Banknote size={15} /> {view.self.loans}</span>
            <span><Backpack size={15} /> B</span>
          </div>
        </div>
        <div className="button-grid compact-actions">
          <button onClick={openLoanConfirm}>
            <Banknote size={18} /> 借 100
          </button>
          <button disabled={view.self.loans <= 0} onClick={() => call("loan:repay", {})}>
            <Check size={18} /> 还 120
          </button>
        </div>
      </div>
      <div className="panel card-vault-launcher">
        <h3>卡牌</h3>
        <div className="card-vault-buttons">
          <button className="card-vault-button" onClick={() => openCardVault("tricks")}>
            <ScrollText size={20} />
            <span>锦囊</span>
            <strong>{view.self.hand.length}</strong>
          </button>
          <button className="card-vault-button event" onClick={() => openCardVault("events")}>
            <BookOpen size={20} />
            <span>事件卡</span>
            <strong>{view.self.events.length}</strong>
          </button>
        </div>
      </div>
    </>
  );
}

function CardVaultOverlay({
  view,
  kind,
  currentArtifact,
  onClose,
  setKind,
  openTargetRequest,
  openConfirmCard
}: {
  view: PlayerView;
  kind: CardVaultKind;
  currentArtifact?: PublicArtifactView;
  onClose: () => void;
  setKind: (kind: CardVaultKind) => void;
  openTargetRequest: (request: TargetRequest) => void;
  openConfirmCard: (card: PlayableCard) => void;
}) {
  const cards: PlayableCard[] = kind === "tricks" ? view.self.hand : view.self.events;
  const title = kind === "tricks" ? "锦囊" : "事件卡";
  const playCard = (card: PlayableCard) => {
    onClose();
    if (card.id === "C04") {
      openTargetRequest({ kind: "consignment", card, defaultArtifactId: currentArtifact?.id });
      return;
    }
    if (targetModeForCard(card) === "none") openConfirmCard(card);
    else openTargetRequest({ kind: "card", card, defaultArtifactId: currentArtifact?.id });
  };

  return (
    <div className="card-vault-layer" role="presentation">
      <section className="card-vault-panel" role="dialog" aria-modal="true" aria-label={`${title}卡牌`}>
        <header className="target-modal-header card-vault-header">
          <div>
            <p className="eyebrow">手牌卡库</p>
            <h3>{title}</h3>
          </div>
          <div className="card-vault-tabs" role="tablist" aria-label="卡牌类型">
            <button className={kind === "tricks" ? "selected" : ""} onClick={() => setKind("tricks")} role="tab" aria-selected={kind === "tricks"}>
              <ScrollText size={17} /> 锦囊 <strong>{view.self.hand.length}</strong>
            </button>
            <button className={kind === "events" ? "selected" : ""} onClick={() => setKind("events")} role="tab" aria-selected={kind === "events"}>
              <BookOpen size={17} /> 事件卡 <strong>{view.self.events.length}</strong>
            </button>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭卡牌库">
            <X size={18} />
          </button>
        </header>

        {cards.length === 0 ? (
          <div className="card-vault-empty">
            <strong>暂无{title}</strong>
            <span>抽到后会出现在这里。</span>
          </div>
        ) : (
          <div className="card-vault-grid">
            {cards.map((card, index) => (
              <GameCardFace
                card={card}
                disabled={!canUseCardFromView(view, card)}
                onUse={() => playCard(card)}
                targetMode={targetModeForCard(card)}
                key={`${card.id}-${index}`}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function GameCardFace({
  card,
  disabled = false,
  onUse,
  targetMode,
  displayOnly = false
}: {
  card: PlayableCard;
  disabled?: boolean;
  onUse?: () => void;
  targetMode?: TargetMode;
  displayOnly?: boolean;
}) {
  const face = gameCardFaceFor(card);
  const timing = card.timings?.join(" / ") ?? phaseLabels[card.timing ?? "cardWindow"] ?? "行动窗口";
  const target = card.target?.text ?? targetTextFor(card.target?.kind);
  return (
    <article className={`mini-card game-card-face game-card-${face.scheme} ${displayOnly ? "display-only" : ""}`}>
      <div className="game-card-topline">
        <span>{card.id}</span>
        <strong>{face.deck}</strong>
      </div>
      <div className="game-card-art" aria-hidden="true">
        <span>{face.mark}</span>
        <b>{face.seal}</b>
      </div>
      <div className="game-card-title">
        <small>{face.category}</small>
        <strong>{card.name}</strong>
      </div>
      <div className="game-card-facts">
        <span>{timing}</span>
        <span>{target}</span>
      </div>
      <p>{card.description}</p>
      <footer>
        <span>{card.cost ? `${card.cost} 银元` : "无消耗"}</span>
        <span>{card.counterable === false ? "不可反制" : "可反制"}</span>
      </footer>
      {!displayOnly && (
        <button data-target-mode={targetMode} disabled={disabled} onClick={onUse}>
          <Eye size={18} /> 使用
        </button>
      )}
    </article>
  );
}

function NoticeModal({ notice, onClose }: { notice: AppNotice; onClose: () => void }) {
  if (notice.kind === "auction") {
    return (
      <div className="modal-backdrop notice-backdrop" role="presentation">
        <section className="target-modal compact-modal notice-modal auction-mode-modal" role="dialog" aria-modal="true" aria-label="今日拍卖方式">
          <header className="target-modal-header">
            <div>
              <p className="eyebrow">今日拍卖</p>
              <h3>{notice.title}</h3>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </header>
          <p className="notice-copy">拍卖方式由系统随机生成，本日主持人不能手动选择。</p>
          <footer className="target-actions">
            <button className="primary" onClick={onClose}>
              <Check size={18} /> 知道了
            </button>
          </footer>
        </section>
      </div>
    );
  }

  if (notice.kind === "loanWarning") {
    return (
      <div className="modal-backdrop notice-backdrop" role="presentation">
        <section className="target-modal compact-modal notice-modal commission-modal" role="dialog" aria-modal="true" aria-label="贷款警告">
          <header className="target-modal-header">
            <div>
              <p className="eyebrow">第 10 天</p>
              <h3>还有贷款未清</h3>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </header>
          <p className="notice-copy">
            你当前还有 {notice.loans} 笔贷款，终局需偿还 {notice.debt} 银元。还不上会先清空现金，再没收 1 件最低价值藏品；如果没有藏品可交出，每差 10 银元扣 1 声望。
          </p>
          <footer className="target-actions">
            <button className="primary" onClick={onClose}>
              <Check size={18} /> 知道了
            </button>
          </footer>
        </section>
      </div>
    );
  }

  if (notice.kind === "commission") {
    return (
      <div className="modal-backdrop notice-backdrop" role="presentation">
        <section className="target-modal compact-modal notice-modal commission-modal" role="dialog" aria-modal="true" aria-label="主持佣金">
          <header className="target-modal-header">
            <div>
              <p className="eyebrow">主持收益</p>
              <h3>佣金到账</h3>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </header>
          <p className="notice-copy">{notice.message}</p>
          <footer className="target-actions">
            <button className="primary" onClick={onClose}>
              <Check size={18} /> 收到
            </button>
          </footer>
        </section>
      </div>
    );
  }

  if (notice.kind === "blackMarketPurchase") {
    const cardKindLabel = notice.cardKind === "trick" ? "锦囊" : "事件卡";
    return (
      <div className="modal-backdrop notice-backdrop" role="presentation">
        <section className="target-modal compact-modal notice-modal black-market-purchase-modal" role="dialog" aria-modal="true" aria-label="黑市购买结果">
          <header className="target-modal-header">
            <div>
              <p className="eyebrow">黑市</p>
              <h3>恭喜你用 {notice.cost} 银元买到了《{notice.card.name}》</h3>
            </div>
            <button className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </header>
          <p className="notice-copy">
            这张{cardKindLabel}已经放入你的手牌，当前剩余 {notice.remainingCash} 银元。
          </p>
          <div className="black-market-card-result">
            <GameCardFace card={notice.card} displayOnly />
          </div>
          <footer className="target-actions">
            <button className="primary" onClick={onClose}>
              <Check size={18} /> 收到
            </button>
          </footer>
        </section>
      </div>
    );
  }

  return (
    <div className="modal-backdrop notice-backdrop" role="presentation">
      <section className="target-modal purchase-modal notice-modal" role="dialog" aria-modal="true" aria-label="成交结果">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">成交</p>
            <h3>恭喜你买到了 {notice.artifacts.map((artifact) => `《${artifact.name}》`).join("、")}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="purchase-grid">
          {notice.artifacts.map((artifact) => (
            <ArtifactDetailCard artifact={artifact} compact={false} key={artifact.id} />
          ))}
        </div>
        <footer className="target-actions">
          <button className="primary" onClick={onClose}>
            <Check size={18} /> 知道了
          </button>
        </footer>
      </section>
    </div>
  );
}

function BackpackOverlay({
  view,
  call,
  onSellArtifact,
  onClose
}: {
  view: PlayerView;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  onSellArtifact: (artifactId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="backpack-layer" aria-label="我的背包">
      <section className="backpack-panel">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">B 背包</p>
            <h3>我的藏品</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {view.self.artifacts.length === 0 ? (
          <p className="empty-text">你还没有买到藏品。</p>
        ) : (
          <div className="backpack-grid">
            {view.self.artifacts.map((artifact) => (
              <div className="backpack-item" key={artifact.id}>
                <ArtifactDetailCard artifact={artifact} compact />
                <button onClick={() => onSellArtifact(artifact.id)}>卖银行</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ArtifactDetailCard({ artifact, compact }: { artifact: PublicArtifactView; compact: boolean }) {
  const properties = artifact.properties ?? [];
  return (
    <article className={`artifact-detail-card ${compact ? "compact" : ""}`}>
      <div className="artifact-detail-head">
        <span>{artifact.categoryLabel ?? (artifact.category ? CATEGORY_LABELS[artifact.category] : "类别未知")}</span>
        <strong>{artifact.name}</strong>
      </div>
      <div className="artifact-detail-facts">
        <span>成交价/到手价 {artifact.purchasePrice ?? "?"} 银元</span>
        <span>实际价格 {artifact.trueValue ?? "?"} 银元</span>
        <span>{artifact.tagLabel ?? "属性标签未知"}</span>
      </div>
      {artifact.story && <p>{artifact.story}</p>}
      <div className="property-list">
        {properties.length === 0 && <small>暂无可见属性。</small>}
        {properties.map((property) => (
          <div className="property-chip" key={property.id}>
            <strong>{property.name}</strong>
            <small>{property.effectText}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

function ownedArtifactsEligibleForSkill(view: PlayerView, skillId: string): PublicArtifactView[] {
  if (skillId === "role08_skill01") return view.self.artifacts.filter((artifact) => artifact.purchasePrice !== undefined && artifact.rumorMin !== undefined && artifact.purchasePrice < artifact.rumorMin);
  return view.self.artifacts;
}

function LoanConfirmModal({
  view,
  onClose,
  onConfirm
}: {
  view: PlayerView;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const debtAfterBorrow = [...(view.self.loanRepayments ?? []), 120].reduce((sum, repayment) => sum + repayment, 0);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal compact-modal" role="dialog" aria-modal="true" aria-label="确认借款">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">钱庄</p>
            <h3>确认借 100 银元？</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="confirm-copy">
          <p>借款后你立刻获得 100 银元。</p>
          <p>当前未还总额会变成 <strong>{debtAfterBorrow}</strong> 银元。</p>
          <p>第 10 天终局前必须还清，否则会触发现金归零、没收藏品，或按差额扣声望。</p>
        </div>
        <footer className="target-actions">
          <button onClick={onClose}>
            <X size={18} /> 取消
          </button>
          <button className="primary" onClick={onConfirm}>
            <Check size={18} /> 确认借款
          </button>
        </footer>
      </section>
    </div>
  );
}

function SellConfirmModal({
  view,
  artifactId,
  onClose,
  onConfirm
}: {
  view: PlayerView;
  artifactId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const artifact = view.self.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) return null;
  const estimatedPrice = estimateBankSellPrice(view, artifact);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal compact-modal" role="dialog" aria-modal="true" aria-label="确认出售藏品">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">银行出售</p>
            <h3>确认出售《{artifact.name}》？</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="confirm-copy">
          <p>预计卖出价：<strong>{estimatedPrice} 银元</strong></p>
          <p>这是基于当前可见规则做的预估，事件、属性、角色或当日效果可能改变最终到账金额。</p>
        </div>
        <ArtifactDetailCard artifact={artifact} compact />
        <footer className="target-actions">
          <button onClick={onClose}>
            <X size={18} /> 取消
          </button>
          <button className="primary" onClick={onConfirm}>
            <Check size={18} /> 确认出售
          </button>
        </footer>
      </section>
    </div>
  );
}

function PublicPool({ view, currentArtifact }: { view: PlayerView; currentArtifact?: PublicArtifactView }) {
  const auctionMode = view.auction ? auctionModeLabel(view.auction.mode, view.auction.bundleInnerMode) : "未生成";
  const auctionRange = currentArtifact?.rumorMin !== undefined ? `${currentArtifact.rumorMin} - ${currentArtifact.rumorMax} 银元` : "价格区间隐藏";
  return (
    <section className="panel public-pool">
      <div className="public-head">
        <h3><ScrollText size={16} /> 公共池</h3>
        <span>{phaseLabels[view.phase]} · {auctionMode}</span>
      </div>
      <div className="public-summary">
        <div>
          <span>当前拍品</span>
          <strong>{currentArtifact?.name ?? "等待预展"}</strong>
        </div>
        <div>
          <span>价格区间</span>
          <strong>{auctionRange}</strong>
        </div>
      </div>
      <div className="public-log-list">
        {view.log.length === 0 && <p className="empty-text">暂无公开行动。</p>}
        {view.log.map((item, index) => {
          const logType = classifyLogMessage(item);
          return (
            <p key={`${item}-${index}`} className={`log-${logType}`}>
              {highlightNumbers(item)}
            </p>
          );
        })}
      </div>
    </section>
  );
}

function CardConfirmModal({ card, onClose, onConfirm }: { card: PlayableCard; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal compact-modal game-card-confirm-modal" role="dialog" aria-modal="true" aria-label={`确认使用 ${card.name}`}>
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">确认使用</p>
            <h3>{card.name}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <GameCardFace card={card} displayOnly />
        <footer className="target-actions">
          <button onClick={onClose}>
            <X size={18} /> 取消
          </button>
          <button className="primary" onClick={onConfirm}>
            <Check size={18} /> 确认使用
          </button>
        </footer>
      </section>
    </div>
  );
}

function gameCardFaceFor(card: PlayableCard) {
  const category = card.category ?? "锦囊";
  const isEvent = card.id.startsWith("E") || card.id.startsWith("N");
  if (isEvent) return { deck: "事件", category, scheme: "event", mark: "势", seal: category.slice(0, 1) || "事" };
  if (category.includes("信息")) return { deck: "锦囊", category, scheme: "trick", mark: "计", seal: "知" };
  if (category.includes("竞价")) return { deck: "锦囊", category, scheme: "trick", mark: "价", seal: "拍" };
  if (category.includes("现金")) return { deck: "锦囊", category, scheme: "trick", mark: "财", seal: "银" };
  if (category.includes("反制")) return { deck: "锦囊", category, scheme: "trick", mark: "破", seal: "止" };
  return { deck: "锦囊", category, scheme: "trick", mark: "扰", seal: "禁" };
}

function targetTextFor(kind?: string) {
  if (kind === "self") return "自己";
  if (kind === "player") return "玩家";
  if (kind === "artifact") return "藏品";
  if (kind === "auction") return "竞拍";
  if (kind === "global") return "全场";
  return "无指定目标";
}

function estimateBankSellPrice(view: PlayerView, artifact: PublicArtifactView): number {
  const rumorMin = artifact.rumorMin ?? 0;
  let rate = 0.8;
  if (view.self.role?.id === "role02") rate = 1;
  if (artifact.properties?.some((property) => property.id === "prop11")) rate = 1.1;

  const todayEffects = view.activeEffects.filter((effect) => effect.day === undefined || effect.day === view.day);
  const explicitRate = todayEffects
    .map((effect) => effect.bankSellRate)
    .filter((value): value is number => typeof value === "number")
    .at(-1);
  if (explicitRate !== undefined) rate = explicitRate;

  if (todayEffects.some((effect) => effect.sourceCardId === "C01" && effect.createdBy === view.selfId)) rate = 1;

  const propertyPenalty = artifact.properties?.some((property) => property.id === "prop25") ? 0.8 : 1;
  return Math.floor(rumorMin * rate * propertyPenalty);
}

function SettingsModal({
  view,
  call,
  onClose,
  bgm
}: {
  view: PlayerView;
  call: <T>(event: keyof ClientToServerEvents, payload: unknown) => void;
  onClose: () => void;
  bgm: { volume: number; enabled: boolean; setVolume: (v: number) => void; toggleEnabled: () => void };
}) {
  const [confirmCloseRoom, setConfirmCloseRoom] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="target-modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <header className="target-modal-header">
          <div>
            <p className="eyebrow">设置</p>
            <h3>房间与教程</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="settings-actions">
          <button
            className={view.paused ? "" : "primary"}
            onClick={() => call("room:setPaused", { paused: !view.paused })}
          >
            {view.paused ? <Play size={18} /> : <Pause size={18} />}
            {view.paused ? "恢复" : "暂停"}
          </button>
          <button className="danger-button" onClick={() => setConfirmCloseRoom(true)}>
            <X size={18} /> 退出房间
          </button>
          {view.phase === "finalScoring" && (
            <button className="primary" onClick={() => call("room:rematch", {})}>
              <RefreshCw size={18} /> 再来一局
            </button>
          )}
          <span>所有玩家都可以暂停或恢复；房主额外拥有管理配置。</span>
        </div>
        <section className="settings-music">
          <h3><History size={16} /> 背景音乐</h3>
          <div className="music-controls">
            <button className={bgm.enabled ? "primary" : ""} onClick={bgm.toggleEnabled}>
              {bgm.enabled ? <Play size={16} /> : <X size={16} />}
              {bgm.enabled ? "已开启" : "已关闭"}
            </button>
            <div className="volume-slider">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={bgm.enabled ? bgm.volume : 0}
                onChange={(e) => bgm.setVolume(Number(e.target.value))}
                aria-label="音量"
              />
              <span>{Math.round((bgm.enabled ? bgm.volume : 0) * 100)}%</span>
            </div>
          </div>
        </section>
        <section className="shortcut-help">
          <div>
            <strong>Tab</strong>
            <span>按住查看玩家信息和自己的秘密委托。</span>
          </div>
          <div>
            <strong>B</strong>
            <span>按住查看背包、藏品成交价、实际价格和属性。</span>
          </div>
        </section>
        {confirmCloseRoom && (
          <section className="leave-room-panel">
            <strong>确认退出房间？</strong>
            <p>这会让所有玩家离开当前房间，旧房间不能继续，需要重新创建房间。</p>
            <div className="settings-actions">
              <button onClick={() => setConfirmCloseRoom(false)}>
                <X size={18} /> 取消
              </button>
              <button className="danger-button" onClick={() => call("room:close", {})}>
                <Check size={18} /> 确认退出
              </button>
            </div>
          </section>
        )}
        {view.canManageRoom && <RoomAdminPanel view={view} call={call} />}
        <section className="tutorial-panel">
          <h3><BookOpen size={18} /> 新手教程</h3>
          <p>每一天先获得收入，再预展拍品；推进预展后系统随机决定拍卖方式。</p>
          <p>买到藏品时记录的是成交价，不是声望；终局才按现金和藏品价值每 50 银元折算声望。</p>
          <p>锦囊和事件卡在右侧手牌区分开显示，使用前会先确认；有目标的卡需要先选玩家或藏品。</p>
          <p>按住 Tab 查看玩家信息和自己的秘密委托；按住 B 查看自己的背包和藏品详情，松开按键即关闭。</p>
          <p>公共池只展示阶段、拍卖、成交和公开信息；自己的用牌、黑市购买和目标会在“我的操作”里显示。</p>
        </section>
      </section>
    </div>
  );
}

function LogPanel({
  title,
  icon,
  log,
  emptyText = "暂无记录。"
}: {
  title: string;
  icon: ReactNode;
  log: string[];
  emptyText?: string;
}) {
  return (
    <section className="panel log-panel">
      <h3>{icon}{title}</h3>
      {log.length === 0 && <p className="empty-text">{emptyText}</p>}
      {log.map((item, index) => {
        const logType = classifyLogMessage(item);
        return (
          <p key={`${item}-${index}`} className={`log-${logType}`}>
            {highlightNumbers(item)}
          </p>
        );
      })}
    </section>
  );
}

type LogMessageType = 'action' | 'income' | 'auction' | 'trade' | 'card' | 'system';

function classifyLogMessage(message: string): LogMessageType {
  if (message.includes('出价') || message.includes('竞拍') || message.includes('成交') || message.includes('拍卖')) return 'auction';
  if (message.includes('收入') || message.includes('掷骰')) return 'income';
  if (message.includes('使用') || message.includes('打出') || message.includes('锦囊') || message.includes('事件卡')) return 'card';
  if (message.includes('交易') || message.includes('换')) return 'trade';
  if (message.includes('推进') || message.includes('阶段') || message.includes('开始')) return 'system';
  return 'action';
}

function highlightNumbers(text: string): ReactNode {
  const parts = text.split(/(\d+\s*银元?|\+\d+|-\d+|第\s*\d+\s*天)/g);
  return parts.map((part, i) => {
    if (/(\d+\s*银元?|\+\d+|-\d+|第\s*\d+\s*天)/.test(part)) {
      return <span key={i} className="log-highlight-number">{part}</span>;
    }
    return part;
  });
}

function FinalScores({ view }: { view: PlayerView }) {
  const ranked = [...view.players].sort((a, b) => (b.finalScore?.reputation ?? 0) - (a.finalScore?.reputation ?? 0));
  return (
    <div className="scoreboard-layer final-score-layer" aria-label="终局结算">
      <section className="scoreboard-panel final-panel final-scoreboard">
        <div className="final-panel-head">
          <div>
            <p className="eyebrow">终局结算</p>
            <h3>终局排名</h3>
          </div>
          <span>现金声望 + 藏品声望 + 委托 + 事件/属性</span>
        </div>
        <div className="final-score-grid scrollable">
          {ranked.map((player, index) => {
            const score = player.finalScore;
            return (
              <article className={`final-score-card ${player.id === view.selfId ? "self" : ""}`} key={player.id}>
                <header>
                  <strong>{index + 1}. {player.nickname}{player.id === view.selfId ? " · 你" : ""}</strong>
                  <span>{score?.reputation ?? 0} 声望</span>
                </header>
                <div className="final-score-breakdown">
                  <p><span>现金声望</span><b>+{score?.cashRep ?? 0}</b></p>
                  <p><span>藏品声望</span><b>+{score?.artifactRep ?? 0}</b></p>
                  <p><span>类别/套装</span><b>+{score?.categoryRep ?? 0}</b></p>
                  <p><span>委托声望</span><b>+{score?.missionRep ?? 0}</b></p>
                  <p><span>事件卡</span><b>{formatSignedScore(score?.eventRep ?? 0)}</b></p>
                  <p><span>属性</span><b>{formatSignedScore(score?.propertyRep ?? 0)}</b></p>
                  <p><span>贷款惩罚</span><b>{formatSignedScore(-(score?.loanPenalty ?? 0))}</b></p>
                  <p><span>角色惩罚</span><b>{formatSignedScore(-(score?.rolePenalty ?? 0))}</b></p>
                </div>
                <div className="final-score-meta">
                  <small>现金 {score?.cashAfterLoan ?? 0}，按每 {score?.cashDivisor ?? 50} 银元折 1 声望</small>
                  <small>藏品总价值 {score?.artifactValue ?? 0} 银元</small>
                  <small>未还贷款 {score?.loanDebt ?? 0} 银元</small>
                </div>
                <div className="final-score-missions">
                  {(score?.missionResults ?? []).length === 0 && <small>无秘密委托</small>}
                  {(score?.missionResults ?? []).map((result) => {
                    const mission = view.catalog.missions.find((candidate) => candidate.id === result.missionId);
                    return (
                      <small key={`${player.id}-${result.missionId}`}>
                        {mission?.name ?? result.missionId} · {result.success ? `成功 +${result.reputation}` : "失败 +0"}
                      </small>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** `~` 键实时预期声望面板（类似终局结算，只显示自己） */
function ProjectionPanel({ view }: { view: PlayerView }) {
  const score = view.projectedScore;
  if (!score) return null;
  return (
    <div className="projection-backdrop" onClick={() => {}} role="presentation">
      <section className="scoreboard-panel projection-panel" role="dialog" aria-modal="true" aria-label="实时预期声望">
        <header className="projection-header">
          <div>
            <p className="eyebrow">实时预期声望（按 `~` 或 ESC 关闭）</p>
            <h3>当前实时预期：{score.reputation} 声望</h3>
          </div>
        </header>
        <div className="projection-scroll">
          <div className="final-score-breakdown">
            <p><span>现金声望</span><b>+{score.cashRep}</b></p>
            <p><span>藏品声望</span><b>+{score.artifactRep}</b></p>
            <p><span>类别/套装</span><b>+{score.categoryRep}</b></p>
            <p><span>委托声望</span><b>+{score.missionRep}</b></p>
            <p><span>事件卡</span><b>{formatSignedScore(score.eventRep)}</b></p>
            <p><span>属性</span><b>{formatSignedScore(score.propertyRep)}</b></p>
            <p><span>贷款惩罚</span><b>{formatSignedScore(-score.loanPenalty)}</b></p>
            <p><span>角色惩罚</span><b>{formatSignedScore(-score.rolePenalty)}</b></p>
          </div>
          <div className="final-score-meta">
            <small>现金 {score.cashAfterLoan}，按每 {score.cashDivisor} 银元折 1 声望</small>
            <small>藏品总价值 {score.artifactValue} 银元</small>
            <small>未还贷款 {score.loanDebt} 银元</small>
          </div>
          <div className="final-score-missions">
            {score.missionResults.length === 0 && <small>无秘密委托</small>}
            {score.missionResults.map((result) => {
              const mission = view.catalog.missions.find((candidate) => candidate.id === result.missionId);
              return (
                <small key={result.missionId}>
                  {mission?.name ?? result.missionId} - {result.success ? `成功 +${result.reputation}` : "失败 +0"}
                </small>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
function formatTradeAssets(assets: PlayerView["tradeOffers"][number]["give"], view: PlayerView): string {
  const parts: string[] = [];
  if (assets.cash) parts.push(`${assets.cash} 银元`);
  for (const id of assets.artifactIds ?? []) {
    parts.push(findArtifactName(view, id));
  }
  if (assets.cardIds?.length) parts.push(`${assets.cardIds.length} 张卡`);
  return parts.length ? parts.join("、") : "无";
}

function formatSignedScore(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function visibleTableArtifacts(view: PlayerView): PublicArtifactView[] {
  if (!view.auction) {
    if (view.phase === "preview" || view.phase === "cardWindow") return view.todayArtifacts.filter((artifact) => !artifact.ownerId);
    return [];
  }
  const activeIds =
    view.auction.mode === "bundle"
      ? view.auction.artifactIds
      : view.auction.artifactIds.slice(view.auction.currentArtifactIndex);
  const activeIdSet = new Set(activeIds);
  return view.todayArtifacts.filter((artifact) => activeIdSet.has(artifact.id) && !artifact.ownerId);
}

function findArtifactName(view: PlayerView, artifactId: string): string {
  const pools = [view.self.artifacts, view.todayArtifacts, ...view.players.map((player) => player.artifacts ?? [])];
  return pools.flat().find((artifact) => artifact.id === artifactId)?.name ?? "藏品";
}

function targetModeForCard(card: PlayableCard): TargetMode {
  if (card.id === "D02") return "playerArtifact";
  if (card.id === "D07") return "playerAuctionArtifact";
  if (card.id === "C04") return "ownedArtifact";
  if (["D01", "D03", "D04", "D05", "D06", "B08", "I04", "I05"].includes(card.id)) return "player";
  if (["I08", "I09", "I12"].includes(card.id)) return "none";
  if (card.target?.kind === "player") return "player";
  if (card.target?.kind === "artifact") return card.type === "cash" ? "ownedArtifact" : "artifact";
  if (card.effects?.some((effect) => effect.type === "revealInfo" && effect.target.kind === "artifact")) return "artifact";
  return "none";
}

function targetModeForRoleSkill(skillId: string): TargetMode {
  if (skillId === "role03_skill01" || skillId === "role01_skill02" || skillId === "role08_skill01") return "ownedArtifact";
  if (skillId === "role01_skill01" || skillId === "role07_skill01") return "artifact";
  if (skillId === "role06_skill01") return "player";
  if (skillId === "role06_skill03") return "playerMission";
  if (skillId === "role03_skill02") return "playerSwap";
  // role05_skill02（千术）不需要目标，直接修改自己的暗标
  return "none";
}

function canUseCardFromView(view: PlayerView, card: PlayableCard): boolean {
  if (isEventCard(view, card) && view.phase !== "eventWindow") return false;
  if (card.id === "C08" && view.phase !== "freeTrade") return false;
  if (card.id === "C04" && view.phase !== "freeTrade") return false;
  const mode = targetModeForCard(card);
  if (mode === "none") return true;
  if (mode === "player") return view.players.some((player) => player.id !== view.selfId);
  if (mode === "artifact") return view.todayArtifacts.length > 0 || view.self.artifacts.length > 0;
  if (mode === "ownedArtifact") return view.self.artifacts.length > 0;
  if (mode === "playerAuctionArtifact") return view.todayArtifacts.length > 0 && view.players.some((player) => player.id !== view.selfId);
  if (mode === "playerArtifact") return view.players.some((player) => player.id !== view.selfId && (player.artifacts?.length ?? player.artifactCount) > 0);
  return true;
}

function isEventCard(view: PlayerView, card: PlayableCard): card is EventCard {
  return view.self.events.some((eventCard) => eventCard.id === card.id);
}

function canUseRoleSkillFromView(view: PlayerView, skill: RoleSkill): boolean {
  const charges = view.self.roleSkillCharges?.[skill.id];
  if (typeof charges === "number" && charges <= 0) return false;
  if (skill.id === "role06_skill01" && view.phase !== "blackMarket") return false;

  if (skill.id === "role01_skill01" && !["preview", "cardWindow", "auction"].includes(view.phase)) return false;
  if (skill.id === "role01_skill02" && view.phase !== "blackMarket") return false;
  if (skill.id === "role03_skill01" && view.day < view.maxDays && view.phase !== "finalScoring") return false;
  if (skill.id === "role05_skill01" && view.phase !== "dayIncome") return false;
  if (skill.id === "role06_skill03" && view.self.cash < 50) return false;
  if (skill.id === "role07_skill01" && !["preview", "cardWindow", "auction"].includes(view.phase)) return false;
  if (skill.id === "role03_skill02" && view.phase !== "freeTrade") return false;
  if (skill.id === "role08_skill01" && view.phase !== "settlement") return false;
  if (skill.id === "role09_skill03") {
    if (view.phase !== "auction" || view.currentHostId !== view.selfId || !view.auction) return false;
    const bidMode = view.auction.mode === "bundle" ? (view.auction.bundleInnerMode ?? "english") : view.auction.mode;
    if (bidMode !== "english") return false;
  }

  // 千术：只能在暗标拍卖且已提交暗标后使用
  if (skill.id === "role05_skill02") {
    if (view.phase !== "auction" || !view.auction) return false;
    const bidMode = view.auction.mode === "bundle" ? (view.auction.bundleInnerMode ?? "sealed") : view.auction.mode;
    if (bidMode !== "sealed") return false;
    if (view.auction.ownSealedBid === undefined) return false;
    return true;
  }

  const mode = targetModeForRoleSkill(skill.id);
  if (mode === "none") return true;
  if (mode === "player" || mode === "playerMission") return view.players.some((player) => player.id !== view.selfId);
  if (mode === "ownedArtifact") return view.self.artifacts.length > 0;
  return view.todayArtifacts.length > 0 || view.self.artifacts.length > 0;
}

function canRespondChoiceEffect(effect: ActiveEffect, view: PlayerView): boolean {
  if (!effect.pendingChoice) return false;
  if (effect.day !== undefined && effect.day > view.day) return false;
  if (effect.choiceType === "C04_listing") return effect.createdBy !== view.selfId;
  if (effect.choiceType === "role01_skill01_choice") return effect.createdBy === view.selfId;
  return effect.targetPlayerId === view.selfId;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

function appendedLogItems(previous: string[], current: string[]): string[] {
  if (current.length === 0) return [];
  const maxOverlap = Math.min(previous.length, current.length);
  for (let overlap = maxOverlap; overlap >= 0; overlap -= 1) {
    const previousTail = previous.slice(previous.length - overlap);
    const currentHead = current.slice(0, overlap);
    if (previousTail.every((item, index) => item === currentHead[index])) {
      return current.slice(overlap);
    }
  }
  return current;
}

function buildBlackMarketPurchaseNotice(
  event: keyof ClientToServerEvents,
  payload: unknown,
  previousView: PlayerView | undefined,
  nextView: PlayerView
): AppNotice | undefined {
  if (event !== "blackMarket:buy" || !previousView) return undefined;
  if (previousView.roomId !== nextView.roomId || previousView.selfId !== nextView.selfId) return undefined;
  const kind = (payload as { kind?: unknown }).kind;
  if (kind !== "trick" && kind !== "event") return undefined;

  const beforeCards = kind === "trick" ? previousView.self.hand : previousView.self.events;
  const afterCards = kind === "trick" ? nextView.self.hand : nextView.self.events;
  const card = firstAddedCard(beforeCards, afterCards);
  if (!card) return undefined;

  return {
    kind: "blackMarketPurchase",
    id: `black-market:${nextView.roomId}:${nextView.selfId}:${nextView.day}:${kind}:${card.id}:${afterCards.length}:${nextView.privateLog.length}`,
    card,
    cardKind: kind,
    cost: Math.max(0, previousView.self.cash - nextView.self.cash),
    remainingCash: nextView.self.cash
  };
}

function firstAddedCard(beforeCards: PlayableCard[], afterCards: PlayableCard[]): PlayableCard | undefined {
  const remaining = new Map<string, number>();
  for (const card of beforeCards) remaining.set(card.id, (remaining.get(card.id) ?? 0) + 1);
  for (const card of afterCards) {
    const count = remaining.get(card.id) ?? 0;
    if (count === 0) return card;
    if (count === 1) remaining.delete(card.id);
    else remaining.set(card.id, count - 1);
  }
  return undefined;
}

function artifactTargetsFor(view: PlayerView, mode: TargetMode, preferredArtifactId?: string, targetPlayerId?: string): PublicArtifactView[] {
  const pool =
    mode === "ownedArtifact"
      ? view.self.artifacts
      : mode === "playerAuctionArtifact"
        ? view.todayArtifacts
      : mode === "playerArtifact"
        ? visibleArtifactsForPlayer(view, targetPlayerId)
        : [...view.todayArtifacts, ...view.self.artifacts];
  return uniqueArtifacts(pool, preferredArtifactId);
}

function visibleArtifactsForPlayer(view: PlayerView, targetPlayerId?: string): PublicArtifactView[] {
  if (!targetPlayerId || targetPlayerId === view.selfId) return view.self.artifacts;
  const player = view.players.find((candidate) => candidate.id === targetPlayerId);
  return uniqueArtifacts(player?.artifacts ?? []);
}

function uniqueArtifacts(artifacts: PublicArtifactView[], preferredArtifactId?: string): PublicArtifactView[] {
  const seen = new Set<string>();
  const unique = artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) return false;
    seen.add(artifact.id);
    return true;
  });
  if (!preferredArtifactId) return unique;
  const preferred = unique.find((artifact) => artifact.id === preferredArtifactId);
  return preferred ? [preferred, ...unique.filter((artifact) => artifact.id !== preferred.id)] : unique;
}

function missionTargetsFor(view: PlayerView, targetPlayerId?: string) {
  if (targetPlayerId === view.selfId) return view.self.missions;
  return view.players.find((player) => player.id === targetPlayerId)?.revealedMissions ?? [];
}

function tradeStatusLabel(status: PlayerView["tradeOffers"][number]["status"]): string {
  if (status === "pending") return "待回应";
  if (status === "accepted") return "已成交";
  if (status === "declined") return "已拒绝";
  return "已取消";
}

function auctionModeLabel(mode: AuctionMode, bundleInnerMode?: Exclude<AuctionMode, "bundle">): string {
  if (mode === "english") return "英式";
  if (mode === "dutch") return "荷兰式";
  if (mode === "sealed") return "暗标";
  return `打包/${bundleInnerMode === "dutch" ? "荷兰式" : bundleInnerMode === "sealed" ? "暗标" : "英式"}`;
}

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms?: number) => string;
  }
}
