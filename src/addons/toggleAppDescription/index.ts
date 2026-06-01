import type { Kintone } from "./types";

(() => {
  const DIALOG_ID = "kintone-dev-tools-toggle-app-description-dialog";
  const STORAGE_KEY = "kintone-dev-tools-hidden-app-ids";
  const HIDE_ALL_STORAGE_KEY = "kintone-dev-tools-hide-all-app-descriptions";

  const STYLES = {
    DIALOG_Z_INDEX: 2147483647,
    MESSAGE_Z_INDEX: 2147483648,
    COLORS: {
      PRIMARY: "#3498db",
      SUCCESS: "#27ae60",
      INFO_BG: "#f0f8ff",
      INFO_BORDER: "#b0d4f1",
      TEXT_SECONDARY: "#666",
      BORDER: "#ccc",
      BUTTON_CANCEL: "#ccc",
      BUTTON_CANCEL_TEXT: "#333",
    },
    TIMING: {
      SUCCESS_MESSAGE_DURATION: 4000,
    },
  } as const;

  const kintoneReadyHookInstalledTargets = new WeakSet<object>();
  const eventsReadyHookInstalledTargets = new WeakSet<object>();
  const eventsOnReadyHookInstalledTargets = new WeakSet<object>();

  const UI_STYLES = {
    DIALOG: {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      background: "white",
      padding: "20px",
      borderRadius: "8px",
      boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
      zIndex: STYLES.DIALOG_Z_INDEX.toString(),
      width: "520px",
      display: "flex",
      flexDirection: "column",
      gap: "15px",
      color: "#333",
      fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    },
    TITLE: {
      textAlign: "center",
      margin: "0 0 10px 0",
    },
    APP_LABEL: {
      fontSize: "0.9em",
      margin: "0 0 10px 0",
      padding: "8px",
      background: STYLES.COLORS.INFO_BG,
      border: `1px solid ${STYLES.COLORS.INFO_BORDER}`,
      borderRadius: "4px",
      fontWeight: "bold",
    },
    DESCRIPTION: {
      fontSize: "0.9em",
      margin: "0 0 10px 0",
      color: STYLES.COLORS.TEXT_SECONDARY,
    },
    INPUT_LABEL: {
      display: "block",
      marginBottom: "5px",
      fontWeight: "bold",
    },
    INPUT_FIELD: {
      width: "calc(100% - 12px)",
      padding: "8px",
      border: `1px solid ${STYLES.COLORS.BORDER}`,
      borderRadius: "4px",
      fontSize: "0.95em",
    },
    BOTTOM_CONTAINER: {
      display: "flex",
      flexDirection: "column",
      marginTop: "10px",
      gap: "10px",
    },
    CHECKBOX_WRAPPER: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      fontSize: "0.9em",
      color: "#333",
      cursor: "pointer",
    },
    CHECKBOX_NOTE: {
      margin: "6px 0 0 0",
      fontSize: "0.82em",
      color: STYLES.COLORS.TEXT_SECONDARY,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      width: "100%",
    },
    CHECKBOX_AREA: {
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      width: "100%",
    },
    BUTTON_CONTAINER: {
      display: "flex",
      justifyContent: "flex-end",
      gap: "10px",
      width: "100%",
    },
  } as const;

  const MESSAGES = {
    DIALOG_TITLE: "アプリ説明欄の表示/非表示",
    CURRENT_APP_ID: "現在のアプリID: ",
    DESCRIPTION:
      "説明欄を自動的に非表示にしたいアプリIDを半角数字/カンマ区切りで入力してください。",
    HIDE_ALL_CHECKBOX: "すべてのアプリで説明欄を非表示にする",
    HIDE_ALL_NOTE:
      "※ すべてのアプリで説明欄を非表示にしても、アプリIDの設定は保持されます。",
    INPUT_LABEL: "アプリID (カンマ区切り)",
    INPUT_PLACEHOLDER: "例: 1, 54, 67",
    BUTTON_CLOSE: "閉じる",
    BUTTON_SAVE: "保存",
    SUCCESS_SAVED: "✓ 設定を保存しました",
    ERROR_SAVE_FAILED: "設定の保存に失敗しました。",
  } as const;

  const EVENT_TYPES = [
    "app.record.index.show",
    "app.record.detail.show",
    "app.record.create.show",
    "app.record.edit.show",
    "app.report.show",
  ] as const;

  type ParsedAppIds = {
    appIds: number[];
    invalidTokens: string[];
  };

  type ToggleAppDescriptionSettings = {
    hiddenAppIds: number[];
    hideAllEnabled: boolean;
  };

  function getKintone(): Kintone | undefined {
    return (globalThis as { kintone?: Kintone }).kintone;
  }

  /*
   * 以下、ヘルパー関数
   */

  // ローカルストレージから値を取得する際の共通関数
  function getStorageValue<T>(
    key: string,
    fallbackValue: T,
    errorLabel: string,
  ): T {
    try {
      const stored = localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : fallbackValue;
    } catch (error) {
      console.error(`[Kintone Dev Tools] Failed to get ${errorLabel}:`, error);
      return fallbackValue;
    }
  }

  // ローカルストレージに値を保存する際の共通関数
  function saveStorageValue<T>(
    key: string,
    value: T,
    errorLabel: string,
  ): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`[Kintone Dev Tools] Failed to save ${errorLabel}:`, error);
      throw error;
    }
  }

  // 説明欄を非表示にすべきか判定する関数
  function shouldHideDescription(
    appId: number,
    hideAllEnabled: boolean,
    hiddenAppIds: number[],
  ): boolean {
    return hideAllEnabled || hiddenAppIds.includes(appId);
  }

  // 入力欄を有効/無効にしたときの見た目も一緒に切り替える関数
  function updateInputFieldState(
    inputField: HTMLInputElement,
    disabled: boolean,
  ): void {
    inputField.disabled = disabled;
    inputField.style.backgroundColor = disabled ? "#f5f5f5" : "white";
    inputField.style.cursor = disabled ? "not-allowed" : "text";
  }

  // localStorage由来の値を、重複なしの正しいアプリID配列へ正規化する
  function normalizeHiddenAppIds(storedValue: unknown): number[] {
    if (!Array.isArray(storedValue)) return [];
    return [
      ...new Set(
        storedValue.filter(
          (id): id is number => Number.isInteger(id) && id > 0,
        ),
      ),
    ];
  }

  // localStorage の詳細を隠蔽して設定オブジェクトを読む/保存するための API
  const settings = {
    // 現在設定を読み込み、UI で使える安全な型へ正規化して返す
    get(): ToggleAppDescriptionSettings {
      const storedHiddenAppIds = getStorageValue<unknown>(
        STORAGE_KEY,
        [],
        "hidden app IDs",
      );
      const hideAllEnabled = getStorageValue<boolean>(
        HIDE_ALL_STORAGE_KEY,
        false,
        "hide-all setting",
      );

      return {
        hiddenAppIds: normalizeHiddenAppIds(storedHiddenAppIds),
        hideAllEnabled: hideAllEnabled === true,
      };
    },

    // 設定全体を同じ窓口で保存する
    set(nextSettings: ToggleAppDescriptionSettings): void {
      saveStorageValue(
        STORAGE_KEY,
        nextSettings.hiddenAppIds,
        "hidden app IDs",
      );
      saveStorageValue(
        HIDE_ALL_STORAGE_KEY,
        nextSettings.hideAllEnabled,
        "hide-all setting",
      );
    },
  };

  // kintoneの説明欄を開く/閉じる処理を実行する関数
  async function setAppDescriptionState(
    targetState: "OPEN" | "CLOSED",
  ): Promise<void> {
    const app = getKintone()?.app;
    if (!app) return;

    try {
      await app.showDescription(targetState);
    } catch (error) {
      console.error(
        `[Kintone Dev Tools] Error setting app description to ${targetState}:`,
        error,
      );
    }
  }

  /*
   * 以下、UI関連関数
   */

  // タグ名を渡すと、スタイル付きの要素を作って返す共通関数
  function createStyledElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    styles: Partial<CSSStyleDeclaration>,
    textContent?: string,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    Object.assign(element.style, styles);
    if (textContent) element.textContent = textContent;
    return element;
  }

  // 共通デザインのボタンを作る関数
  function createButton(
    text: string,
    backgroundColor: string,
    textColor: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = createStyledElement(
      "button",
      {
        padding: "8px 15px",
        background: backgroundColor,
        color: textColor,
        border: "none",
        borderRadius: "4px",
        cursor: "pointer",
        fontSize: "0.95em",
        whiteSpace: "nowrap",
        minWidth: "96px",
      },
      text,
    );
    button.onclick = onClick;
    return button;
  }

  // DOMが読み込み済みなら即実行、まだなら読み込み完了後に1回だけ実行する関数
  function runWhenDomReady(callback: () => void): void {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  // 保存成功メッセージを一時表示する関数
  function showSuccessMessage(message: string): void {
    const host = document.body ?? document.documentElement;
    if (!host) return;

    const successMsg = createStyledElement(
      "div",
      {
        position: "fixed",
        top: "20px",
        left: "50%",
        transform: "translateX(-50%)",
        background: STYLES.COLORS.SUCCESS,
        color: "white",
        padding: "12px 24px",
        borderRadius: "4px",
        zIndex: STYLES.MESSAGE_Z_INDEX.toString(),
        fontSize: "0.95em",
      },
      message,
    );
    host.appendChild(successMsg);
    setTimeout(
      () => successMsg.remove(),
      STYLES.TIMING.SUCCESS_MESSAGE_DURATION,
    );
  }

  // 入力値をアプリIDへ変換し、無効値は通知用に返す
  function parseAppIds(input: string): ParsedAppIds {
    const rawTokens = input
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    const validAppIds: number[] = [];
    const invalidTokens: string[] = [];

    for (const token of rawTokens) {
      if (!/^\d+$/.test(token)) {
        invalidTokens.push(token);
        continue;
      }

      const appId = Number(token);
      if (!Number.isInteger(appId) || appId <= 0) {
        invalidTokens.push(token);
        continue;
      }

      validAppIds.push(appId);
    }

    return {
      appIds: [...new Set(validAppIds)],
      invalidTokens: [...new Set(invalidTokens)],
    };
  }

  // 無効値の表示文を短く整える
  function formatInvalidTokenSummary(tokens: string[], maxItems = 5): string {
    const visibleTokens = tokens.slice(0, maxItems).join(", ");
    if (tokens.length <= maxItems) {
      return visibleTokens;
    }

    return `${visibleTokens}, 他${(tokens.length - maxItems).toString()}件`;
  }

  // ダイアログ下部（チェックボックス + ボタン）を組み立てる
  function createDialogFooter(
    dialog: HTMLDivElement,
    inputField: HTMLInputElement,
    initialChecked: boolean,
    currentAppId: number | null,
    previousHiddenAppIds: number[],
    previousHideAllEnabled: boolean,
  ): HTMLDivElement {
    const bottomContainer = createStyledElement(
      "div",
      UI_STYLES.BOTTOM_CONTAINER,
    );

    const checkboxWrapper = createStyledElement(
      "label",
      UI_STYLES.CHECKBOX_WRAPPER,
    );

    const hideAllCheckbox = createStyledElement("input", {
      margin: "0",
      cursor: "pointer",
    }) as HTMLInputElement;
    hideAllCheckbox.type = "checkbox";
    hideAllCheckbox.checked = initialChecked;

    checkboxWrapper.appendChild(hideAllCheckbox);
    checkboxWrapper.appendChild(
      document.createTextNode(MESSAGES.HIDE_ALL_CHECKBOX),
    );

    const checkboxNote = createStyledElement(
      "p",
      UI_STYLES.CHECKBOX_NOTE,
      MESSAGES.HIDE_ALL_NOTE,
    );
    checkboxNote.title = MESSAGES.HIDE_ALL_NOTE;

    const checkboxArea = createStyledElement("div", UI_STYLES.CHECKBOX_AREA);
    checkboxArea.appendChild(checkboxWrapper);
    checkboxArea.appendChild(checkboxNote);

    hideAllCheckbox.addEventListener("change", () => {
      updateInputFieldState(inputField, hideAllCheckbox.checked);
    });

    const buttonContainer = createStyledElement(
      "div",
      UI_STYLES.BUTTON_CONTAINER,
    );

    const closeButton = createButton(
      MESSAGES.BUTTON_CLOSE,
      STYLES.COLORS.BUTTON_CANCEL,
      STYLES.COLORS.BUTTON_CANCEL_TEXT,
      () => dialog.remove(),
    );

    const saveButton = createButton(
      MESSAGES.BUTTON_SAVE,
      STYLES.COLORS.PRIMARY,
      "white",
      () =>
        handleSave(
          inputField,
          hideAllCheckbox,
          currentAppId,
          previousHiddenAppIds,
          previousHideAllEnabled,
          dialog,
        ),
    );

    buttonContainer.appendChild(closeButton);
    buttonContainer.appendChild(saveButton);

    bottomContainer.appendChild(checkboxArea);
    bottomContainer.appendChild(buttonContainer);
    return bottomContainer;
  }

  // 設定ダイアログを組み立てて表示する本体関数
  async function showSettingsDialog(): Promise<void> {
    const host = document.body ?? document.documentElement;
    if (!host) {
      runWhenDomReady(() => {
        void showSettingsDialog();
      });
      return;
    }

    document.getElementById(DIALOG_ID)?.remove();

    const app = getKintone()?.app;

    const dialog = createStyledElement("div", UI_STYLES.DIALOG);
    dialog.id = DIALOG_ID;

    const title = createStyledElement(
      "h3",
      UI_STYLES.TITLE,
      MESSAGES.DIALOG_TITLE,
    );
    dialog.appendChild(title);

    const currentAppId = app?.getId() ?? null;
    if (currentAppId != null) {
      const appLabel = createStyledElement(
        "p",
        UI_STYLES.APP_LABEL,
        `${MESSAGES.CURRENT_APP_ID}${currentAppId.toString()}`,
      );
      dialog.appendChild(appLabel);
    }

    const description = createStyledElement(
      "p",
      UI_STYLES.DESCRIPTION,
      MESSAGES.DESCRIPTION,
    );
    dialog.appendChild(description);

    const inputLabel = createStyledElement(
      "label",
      UI_STYLES.INPUT_LABEL,
      MESSAGES.INPUT_LABEL,
    );
    dialog.appendChild(inputLabel);

    const inputField = createStyledElement(
      "input",
      UI_STYLES.INPUT_FIELD,
    ) as HTMLInputElement;
    inputField.type = "text";
    inputField.placeholder = MESSAGES.INPUT_PLACEHOLDER;

    const {
      hiddenAppIds: previousHiddenAppIds,
      hideAllEnabled: previousHideAllEnabled,
    } = settings.get();

    if (previousHiddenAppIds.length > 0) {
      inputField.value = previousHiddenAppIds.join(", ");
    }
    updateInputFieldState(inputField, previousHideAllEnabled);
    dialog.appendChild(inputField);

    const bottomContainer = createDialogFooter(
      dialog,
      inputField,
      previousHideAllEnabled,
      currentAppId,
      previousHiddenAppIds,
      previousHideAllEnabled,
    );

    dialog.appendChild(bottomContainer);
    host.appendChild(dialog);
  }

  /*
   * 以下、保存・適用関連関数
   */

  // 保存前後の状態差分を見て、現在の画面だけ説明欄表示状態を同期する
  async function syncCurrentAppDescriptionState(
    currentAppId: number | null,
    previousHiddenAppIds: number[],
    previousHideAllEnabled: boolean,
    hideAllEnabled: boolean,
    newHiddenAppIds: number[],
  ): Promise<void> {
    if (currentAppId == null) return;

    const wasHidden = shouldHideDescription(
      currentAppId,
      previousHideAllEnabled,
      previousHiddenAppIds,
    );
    const isNowHidden = shouldHideDescription(
      currentAppId,
      hideAllEnabled,
      newHiddenAppIds,
    );

    if (wasHidden && !isNowHidden) {
      await setAppDescriptionState("OPEN");
    } else if (!wasHidden && isNowHidden) {
      await setAppDescriptionState("CLOSED");
    }
  }

  // ダイアログの保存ボタンを押したときの本処理(入力取得 → バリデーション/変換 → 保存 → 画面反映 → 成功/失敗通知)
  async function handleSave(
    inputField: HTMLInputElement,
    hideAllCheckbox: HTMLInputElement,
    currentAppId: number | null,
    previousHiddenAppIds: number[],
    previousHideAllEnabled: boolean,
    dialog: HTMLElement,
  ): Promise<void> {
    const inputValue = inputField.value.trim();
    const hideAllEnabled = hideAllCheckbox.checked;
    const { appIds: newHiddenAppIds, invalidTokens } = inputValue
      ? parseAppIds(inputValue)
      : { appIds: [], invalidTokens: [] };

    try {
      settings.set({
        hiddenAppIds: newHiddenAppIds,
        hideAllEnabled,
      });

      await syncCurrentAppDescriptionState(
        currentAppId,
        previousHiddenAppIds,
        previousHideAllEnabled,
        hideAllEnabled,
        newHiddenAppIds,
      );

      const successMessage =
        invalidTokens.length === 0
          ? MESSAGES.SUCCESS_SAVED
          : `${MESSAGES.SUCCESS_SAVED}（無効値を除外: ${formatInvalidTokenSummary(invalidTokens)}）`;
      showSuccessMessage(successMessage);
      dialog.remove();
    } catch (error) {
      console.error("[Kintone Dev Tools] Failed to save settings:", error);
      alert(MESSAGES.ERROR_SAVE_FAILED);
    }
  }

  // 現在アプリで、設定に応じて説明欄を自動で開閉する実行関数(設定読み込み → 対象アプリ判定 → 反映)
  async function autoToggleAppDescription(): Promise<void> {
    const appId = getKintone()?.app?.getId();
    if (appId == null) return;

    const { hiddenAppIds, hideAllEnabled } = settings.get();
    const targetState = shouldHideDescription(
      appId,
      hideAllEnabled,
      hiddenAppIds,
    )
      ? "CLOSED"
      : "OPEN";
    await setAppDescriptionState(targetState);
  }

  // kintone.events.on が後から生えてくる場合に備えて、準備完了を監視するフック関数
  function installEventsOnReadyHook(eventsObject: unknown): void {
    if (!eventsObject || typeof eventsObject !== "object") {
      return;
    }

    const targetEvents = eventsObject as { on?: unknown };
    if (
      eventsOnReadyHookInstalledTargets.has(targetEvents) ||
      typeof targetEvents.on === "function"
    ) {
      return;
    }

    eventsOnReadyHookInstalledTargets.add(targetEvents);
    let hookedOn = targetEvents.on;

    try {
      Object.defineProperty(targetEvents, "on", {
        configurable: true,
        enumerable: true,
        get() {
          return hookedOn;
        },
        set(value: unknown) {
          hookedOn = value;
          if (typeof value === "function") {
            Object.defineProperty(targetEvents, "on", {
              value,
              writable: true,
              configurable: true,
              enumerable: true,
            });
            initialize();
          }
        },
      });
    } catch (error) {
      console.warn(
        "[Kintone Dev Tools] Failed to install kintone.events.on ready hook.",
        error,
      );
    }
  }

  // kintone.events 全体が後から差し替わるケースを監視して、使える状態になったら初期化するフック
  function installEventsReadyHook(targetKintone: Kintone | undefined): void {
    if (
      !targetKintone ||
      eventsReadyHookInstalledTargets.has(targetKintone) ||
      typeof targetKintone.events?.on === "function"
    ) {
      return;
    }

    eventsReadyHookInstalledTargets.add(targetKintone);
    let hookedEvents: Kintone["events"] | undefined = targetKintone.events;

    installEventsOnReadyHook(hookedEvents);

    try {
      Object.defineProperty(targetKintone, "events", {
        configurable: true,
        enumerable: true,
        get() {
          return hookedEvents;
        },
        set(value: Kintone["events"]) {
          hookedEvents = value;

          if (typeof value?.on === "function") {
            Object.defineProperty(targetKintone, "events", {
              value,
              writable: true,
              configurable: true,
              enumerable: true,
            });
            initialize();
            return;
          }

          installEventsOnReadyHook(value);
        },
      });
    } catch (error) {
      console.warn(
        "[Kintone Dev Tools] Failed to install kintone.events ready hook.",
        error,
      );
    }
  }

  // global の kintone 変数そのものが後から入る/差し替わるのを監視する最上位フック
  function installKintoneReadyHook(): void {
    const globalObject = globalThis as { kintone?: Kintone };
    installEventsReadyHook(globalObject.kintone);

    if (kintoneReadyHookInstalledTargets.has(globalObject)) return;
    kintoneReadyHookInstalledTargets.add(globalObject);

    let hookedKintone = globalObject.kintone;

    try {
      Object.defineProperty(globalObject, "kintone", {
        configurable: true,
        enumerable: true,
        get() {
          return hookedKintone;
        },
        set(value: Kintone | undefined) {
          hookedKintone = value;
          installEventsReadyHook(value);
          initialize();
        },
      });
    } catch (error) {
      console.warn(
        "[Kintone Dev Tools] Failed to install kintone ready hook.",
        error,
      );
    }
  }

  // このアドオン全体の起動エントリ（準備確認 → 必要なら待機フック設置 → 一度だけイベント登録＋即時反映）
  function initialize(): void {
    const currentKintone = getKintone();
    const events = currentKintone?.events;
    if (typeof events?.on !== "function") {
      installKintoneReadyHook();
      return;
    }

    if (!window.__toggleAppDescriptionInitialized__) {
      window.__toggleAppDescriptionInitialized__ = true;
      events.on([...EVENT_TYPES], () => {
        void autoToggleAppDescription();
      });
      void autoToggleAppDescription();
    }
  }

  /*
   * 以下、初期化
   */

  // 起動時の最終処理ブロック（公開関数登録 + 初期化 + 必要ならUI再表示）
  const shouldOpenDialog = window.__toggleAppDescriptionInitialized__ === true;
  window.showToggleAppDescriptionSettings = showSettingsDialog;
  initialize();
  if (shouldOpenDialog) {
    void showSettingsDialog();
  }
})();
