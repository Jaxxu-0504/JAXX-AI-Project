const fs = require("fs");

const file = "public/index.html";

let text = fs.readFileSync(file, "utf8");

const fixes = {
  "ï¼‹": "＋",
  "ðŸ˜Ž": "😎",
  "â—": "●",
  "ðŸ‘¤": "👤",
  "â–¾": "▾",
  "ðŸ’Ž": "💎",
  "ðŸ”": "🔐",
  "âœ¨": "✨",
  "ðŸšª": "🚪",
  "ðŸ“Ž": "📎",
  "ðŸŽ¬": "🎬",
  "âž¤": "➤",
  "âœ•": "❌",
  "âœ“": "✓",
  "ðŸ†“": "🆓",
  "â­": "⭐",
  "ðŸ‘‘": "👑",
  "â‚¹": "₹",
  "ðŸ—‘ï¸": "🗑️",
  "âœï¸": "✏️",
  "ðŸš€": "🚀",
  "ðŸ’¡": "💡",
  "ðŸ’»": "💻",
  "ðŸ§ ": "🧠",
  "à¤¤à¤¸à¥à¤µà¥€à¤°": "तस्वीर",
  "à¤«à¥‹à¤Ÿà¥‹": "फोटो"
};

for (const [bad, good] of Object.entries(fixes)) {
  text = text.split(bad).join(good);
}

fs.writeFileSync(file, text, "utf8");

console.log("✅ Emoji encoding fixed successfully!");