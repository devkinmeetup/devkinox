/** アプリ説明欄の表示状態 */
export type DescriptionDisplayState = "OPEN" | "CLOSED";

/** kintone.appオブジェクトの型定義 */
export interface KintoneApp {
  /** 現在のアプリIDを取得 */
  getId(): number | null;
  /** アプリ説明欄の表示状態を変更 */
  showDescription(state: DescriptionDisplayState): Promise<void>;
}

/** kintone.eventsオブジェクトの型定義 */
export interface KintoneEvents {
  /** イベントハンドラを登録 */
  on(events: string[], callback: () => void | Promise<void>): void;
}

/** kintoneグローバルオブジェクトの型定義 */
export interface Kintone {
  app: KintoneApp;
  events: KintoneEvents;
}

declare global {
  interface Window {
    /** 設定ダイアログを表示する関数 */
    showToggleAppDescriptionSettings?: () => Promise<void>;
    /** 初期化済みフラグ */
    __toggleAppDescriptionInitialized__?: boolean;
  }
}
