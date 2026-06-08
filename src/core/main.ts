import { loadAddons, getCurrentTab, executeScriptByFile } from "./core.js";
import type { AddonDefinition } from "./core.js";
import { createSwapy } from 'swapy'

document.addEventListener("DOMContentLoaded", async () => {
  const addons: AddonDefinition[] = await loadAddons();
  const buttonsGridDiv = document.getElementById("buttons-grid");
  const noAddonsMessageDiv = document.getElementById("no-addons-message");

  if (!buttonsGridDiv || !noAddonsMessageDiv) return;

  buttonsGridDiv.innerHTML = "";

  if (addons.length === 0) {
    noAddonsMessageDiv.style.display = "block";
    buttonsGridDiv.style.display = "none";
    return;
  }
  noAddonsMessageDiv.style.display = "none";
  buttonsGridDiv.style.display = "grid";

  for (const addon of addons) {
    const slotDiv = document.createElement("div");
    slotDiv.dataset.swapySlot = addon.id;
    slotDiv.className = "slot-container";

    const button = document.createElement("button");
    button.className = "button";
    button.dataset.swapyItem = addon.id;

    const iconElement = document.createElement("i");
    iconElement.className = addon.iconClass;
    button.appendChild(iconElement);

    const textNode = document.createTextNode(addon.label);
    button.appendChild(textNode);

    button.onclick = async () => {
      const tab = await getCurrentTab();
      if (tab?.id && tab.url) {
        const currentUrl = tab.url.toLowerCase();
        if (
          currentUrl.startsWith("chrome://") ||
          currentUrl.startsWith("edge://")
        ) {
          alert(
            "この機能は chrome:// や edge:// のページでは使用できません。\nKintoneのアプリページで実行してください。",
          );
          return;
        }
        if (
          !currentUrl.includes(".cybozu.com/") &&
          !currentUrl.includes(".kintone.com/") &&
          !currentUrl.includes(".kintone.cn/")
        ) {
          alert(
            "この機能はKintoneのページでのみ使用できます。\n現在のページがKintoneのドメインであることを確認してください。",
          );
          return;
        }

        console.log(
          `[kintone Dev Tools] Injecting script: ${addon.contentScriptFile} for addon: ${addon.label} on URL: ${tab.url}`,
        );
        try {
          await executeScriptByFile(tab.id, addon.contentScriptFile);
        } catch (e) {
          console.error(
            `[kintone Dev Tools] Failed to execute script for ${addon.label} on URL: ${tab.url}`,
            e,
          );
        }
      } else {
        console.warn(
          "[kintone Dev Tools] Could not get current tab or tab.url is undefined.",
        );
        alert(
          "現在のタブ情報を取得できませんでした。ブラウザを再起動するか、拡張機能を再読み込みしてみてください。",
        );
      }
    };
    slotDiv.appendChild(button);
    buttonsGridDiv.appendChild(slotDiv);
  }

  const container = document.querySelector<HTMLElement>('.button-section');
  if (!container) {
    alert(
      "ボタン情報を取得できませんでした。ブラウザを再起動するか、拡張機能を再読み込みしてみてください。",
    );
    console.warn(
      "[kintone Dev Tools] .button-section element not found",
    );
    throw new Error('');
  }
  const swapy = createSwapy(container, {
    animation: 'dynamic'
  });

  const settingsIcon = document.querySelector(".settings-icon");
  if (settingsIcon) {
    settingsIcon.addEventListener("click", () => {
      console.log("[kintone Dev Tools] Settings icon clicked (dummy).");
      alert("設定機能は現在準備中です。");
    });
  }
});
