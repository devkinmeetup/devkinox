// kintone の参照系フィールドスキーマと、参照トレースの中間データ構造

/** 参照先アプリ指定（ルックアップ・関連レコード共通） */
export interface RelatedAppRef {
  app?: string | number; // アプリID
  code?: string; // アプリコード（任意運用）
}

/** ルックアップ設定（型は SINGLE_LINE_TEXT / NUMBER 等だが lookup を持つ） */
export interface LookupProperty {
  relatedApp?: RelatedAppRef;
  relatedKeyField?: string; // 相手側のキーフィールド
  fieldMappings?: { field: string; relatedField: string }[]; // コピー先→コピー元
  lookupPickerFields?: string[];
  filterCond?: string;
  sort?: string;
}

/** 関連レコード一覧設定（type === "REFERENCE_TABLE"） */
export interface ReferenceTableProperty {
  relatedApp?: RelatedAppRef;
  condition?: { field: string; relatedField: string };
  displayFields?: string[];
  filterCond?: string;
  sort?: string;
  size?: string;
}

/** フォームフィールドのプロパティ（参照系プロパティを含む拡張版） */
export interface FieldProperty {
  type: string;
  code: string;
  label: string;
  lookup?: LookupProperty; // ルックアップの場合のみ存在
  referenceTable?: ReferenceTableProperty; // 関連レコードの場合のみ存在
  fields?: { [fieldCode: string]: FieldProperty }; // SUBTABLE の内包フィールド
  [key: string]: unknown;
}

/** 参照の種別 */
export type RefKind = "LOOKUP" | "REFERENCE_TABLE";

/** 表形式の1行（フィールド単位の参照設定） */
export interface FieldRef {
  appId: string;
  appName: string;
  tableCode?: string; // サブテーブル内フィールドの場合、その親テーブルコード
  fieldCode: string;
  fieldLabel: string;
  baseType: string; // ルックアップの元型 or "REFERENCE_TABLE"
  kind: RefKind;
  relatedAppId: string;
  relatedAppName: string;
  keyField: string; // ルックアップ: relatedKeyField / 関連: condition.relatedField
  mappings: { field: string; relatedField: string }[];
}

/** 取得ステータス */
export type FetchStatus = "ok" | "forbidden" | "error";

/** アプリ単位のノード */
export interface AppNode {
  appId: string;
  appName: string;
  fetchStatus: FetchStatus;
}

/** アプリ単位のエッジ（fromApp が relatedApp を参照） */
export interface AppEdge {
  fromAppId: string;
  toAppId: string;
  fieldCode: string;
  kind: RefKind;
}

/** トレース結果グラフ */
export interface TraceGraph {
  nodes: AppNode[];
  edges: AppEdge[];
  rows: FieldRef[];
  truncated: boolean; // アプリ数上限に達して打ち切ったか
}
