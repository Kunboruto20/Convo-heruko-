// Import core Baileys functions
import {
  makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason
} from "@whiskeysockets/baileys";

import Pino from "pino";
import fs from "fs";
import readline from "readline";
import process from "process";
import dns from "dns";
import chalk from "chalk";
import qrcode from "qrcode-terminal";

// Helper for delay
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Function to normalize JIDs
function normalizeJid(jid) {
  return jid ? jid.trim().toLowerCase() : "";
}

// Terminal input interface (în română)
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(chalk.red(query), (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Function to wait for an internet connection
async function waitForInternet() {
  console.log(chalk.red("⏳ Conexiunea a fost pierdută. Aștept conexiunea la internet..."));
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      dns.resolve("google.com", (err) => {
        if (!err) {
          console.log(chalk.red("✔ Conexiunea a revenit, reluăm trimiterea..."));
          clearInterval(interval);
          resolve(true);
        }
      });
    }, 5000);
  });
}

// Function to check DNS resolution for web.whatsapp.com
async function checkDNS() {
  return new Promise((resolve, reject) => {
    dns.lookup("web.whatsapp.com", (err) => {
      if (err) reject(err);
      else resolve(true);
    });
  });
}

// Banner afișat în terminal
console.log(chalk.red(`
===================================
        GYOVANNY WHATSAPP SCRIPT👑
===================================`));

// Global configuration and state
global.botConfig = {};
global.configReady = false;
global.connectionMethod = null;
global.owner = null;

let activeSessions = {};     // sesiuni de trimitere mesaje/poze
let activeNameLoops = {};    // sesiuni de looping nume de grup

/**
 * Loop infinit pentru schimbarea subiectului unui grup
 */
async function groupNameLoop(chatId, sock) {
  while (activeNameLoops[chatId]?.running) {
    const loopData = activeNameLoops[chatId];
    const currentName = loopData.groupNames[loopData.currentIndex];
    try {
      await sock.groupUpdateSubject(chatId, currentName);
      console.log(chalk.red(`[GroupNameLoop] Grupul ${chatId} a fost actualizat la: ${currentName}`));
    } catch (error) {
      console.error(chalk.red(`[GroupNameLoop] Eroare la schimbarea numelui grupului ${chatId}:`), error);
    }
    loopData.currentIndex = (loopData.currentIndex + 1) % loopData.groupNames.length;
    await delay(loopData.delay);
  }
  console.log(chalk.red(`[GroupNameLoop] Sesiunea de schimbare nume pentru ${chatId} s-a încheiat.`));
}

/**
 * Pornește o sesiune de trimitere mesaje/poze -- trimite FULL TEXT (cu newline și spații)
 */
async function handleStartCommand(chatId, delayValue, mentionJids, sock) {
  if (activeSessions[chatId]) {
    activeSessions[chatId].delay = delayValue;
    activeSessions[chatId].mentionJids = mentionJids;
    console.log(chalk.red(`Sesiunea pentru ${chatId} a fost actualizată.`));
    return;
  }

  activeSessions[chatId] = {
    running: true,
    delay: delayValue,
    mentionJids,
  };

  const config = global.botConfig;

  // Trimitem primul mesaj instantaneu
  if (config.sendType === "mesaje") {
    let textToSend = config.fullMessage;
    if (mentionJids.length) {
      const mentionsText = mentionJids
        .map((jid) => "@" + normalizeJid(jid).split("@")[0])
        .join(" ");
      textToSend = `${textToSend}\n\n${mentionsText}`;
    }
    try {
      await sock.sendMessage(chatId, {
        text: textToSend,
        contextInfo: { mentionedJid: mentionJids },
      });
      console.log(chalk.red(`👑 Primul mesaj FULL TEXT trimis către ${chatId}`));
    } catch (err) {
      console.error(chalk.red("Eroare la trimiterea primului mesaj full text:"), err);
    }
  } else {
    try {
      await sock.sendMessage(chatId, {
        image: config.photoBuffer,
        caption: config.photoCaption,
        contextInfo: { mentionedJid },
      });
      console.log(chalk.red(`👑 Poză trimisă către ${chatId}`));
    } catch (err) {
      console.error(chalk.red("Eroare la trimiterea primei poze:"), err);
    }
  }

  sendLoop(chatId, sock);
}

/**
 * Oprește o sesiune activă
 */
function handleStopCommand(chatId) {
  if (activeSessions[chatId]) {
    activeSessions[chatId].running = false;
    console.log(chalk.red(`Sesiunea pentru ${chatId} a fost oprită.`));
  }
}

/**
 * Loop principal pentru trimitere FULL TEXT / poze
 */
async function sendLoop(chatId, sock) {
  const config = global.botConfig;
  const session = activeSessions[chatId];

  while (session?.running) {
    await delay(session.delay);

    try {
      if (config.sendType === "mesaje") {
        let textToSend = config.fullMessage;
        if (session.mentionJids.length) {
          const mentionsText = session.mentionJids
            .map((jid) => "@" + normalizeJid(jid).split("@")[0])
            .join(" ");
          textToSend = `${textToSend}\n\n${mentionsText}`;
        }
        await sock.sendMessage(chatId, { text: textToSend, contextInfo: { mentionedJid: session.mentionJids } });
        console.log(chalk.red(`👑 Mesaj FULL TEXT trimis către ${chatId}`));
      } else {
        await sock.sendMessage(chatId, {
          image: config.photoBuffer,
          caption: config.photoCaption,
          contextInfo: { mentionedJid: session.mentionJids },
        });
        console.log(chalk.red(`👑 Poză trimisă către ${chatId}`));
      }
    } catch (error) {
      console.error(chalk.red(`⇌ Eroare la trimiterea către ${chatId}:`), error);
      console.log(chalk.red("⏳ Aștept revenirea internetului..."));
      await waitForInternet();
      console.log(chalk.red("🔄 Reinitializing connection..."));
      return;
    }
  }

  delete activeSessions[chatId];
  console.log(chalk.red(`Sesiunea pentru ${chatId} s-a încheiat.`));
}

/**
 * Reluarea tuturor sesiunilor după reconectare
 */
function resumeActiveSessions(sock) {
  for (const chatId in activeSessions) {
    if (activeSessions[chatId].running) {
      console.log(chalk.red(`Reluăm trimiterea pentru ${chatId}...`));
      sendLoop(chatId, sock);
    }
  }
}

/**
 * Extrage mesajul dintr-un view-once citat
 */
function getInnerMessage(quotedMsg) {
  return quotedMsg.viewOnceMessage?.message || quotedMsg;
}

/**
 * Configurează handler-ele pentru comenzi WhatsApp
 */
function setupCommands(sock) {
  sock.ev.on("messages.upsert", async (up) => {
    if (!up.messages) return;
    for (const msg of up.messages) {
      if (!msg.message || !msg.key.fromMe || !global.configReady) continue;
      const chatId = msg.key.remoteJid;
      let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!text) continue;
      text = text.trim();

      // reacție hourglass
      if (text.startsWith("/") || text === ".vv") {
        try { await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } }); } catch {}
      }

      // .vv: resend view-once media
      if (text === ".vv") {
        const ctx = msg.message.extendedTextMessage?.contextInfo;
        if (!ctx?.quotedMessage) continue;
        try {
          const inner = getInnerMessage(ctx.quotedMessage);
          const fakeMsg = {
            key: {
              remoteJid: chatId,
              id: ctx.stanzaId || msg.key.id,
              fromMe: false,
              participant: ctx.participant,
            },
            message: inner,
          };
          const buffer = await downloadMediaMessage(
            fakeMsg, "buffer", {},
            { logger: Pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
          );
          let content = {};
          if (inner.imageMessage) content = { image: buffer };
          else if (inner.videoMessage) content = { video: buffer };
          else if (inner.audioMessage) content = { audio: buffer };
          else continue;
          await sock.sendMessage(chatId, content);
        } catch (err) {
          console.error(chalk.red("Error .vv:"), err);
        }
        continue;
      }

      if (!text.startsWith("/")) continue;
      const cmd = text.toLowerCase();

      if (cmd === "/reload") {
        console.log(chalk.red("→ /reload nu afectează full-text mode."));
      } else if (cmd === "/stopgroupname") {
        if (activeNameLoops[chatId]) delete activeNameLoops[chatId];
      } else if (cmd.startsWith("/groupname")) {
        const m = text.match(/^\/groupname(\d+)\s+(.+)$/i);
        if (m) {
          const secs = parseInt(m[1], 10);
          const names = m[2].split(",").map(n => n.trim()).filter(n => n);
          if (names.length) {
            activeNameLoops[chatId] = {
              running: true,
              delay: secs * 1000,
              groupNames: names,
              currentIndex: 0,
            };
            groupNameLoop(chatId, sock);
          }
        }
      } else if (cmd.startsWith("/kick")) {
        if (!chatId.endsWith("@g.us")) continue;
        const toKick = text.split(/\s+/).slice(1).map(t => {
          let id = t.replace(/^@/, "");
          if (!id.includes("@")) id += "@s.whatsapp.net";
          return id;
        });
        if (toKick.length) await sock.groupParticipantsUpdate(chatId, toKick, "remove");
      } else if (cmd.startsWith("/add")) {
        if (!chatId.endsWith("@g.us")) continue;
        const toAdd = text.split(/\s+/).slice(1).map(t => {
          let id = t.replace(/^@/, "");
          if (!id.includes("@")) id += "@s.whatsapp.net";
          return id;
        });
        if (toAdd.length) await sock.groupParticipantsUpdate(chatId, toAdd, "add");
      } else if (cmd === "/stop") {
        handleStopCommand(chatId);
      } else if (cmd.startsWith("/start")) {
        const m = text.match(/^\/start(\d*)\s*(.*)$/i);
        if (m) {
          const d = m[1] ? parseInt(m[1], 10) * 1000 : global.botConfig.defaultDelay;
          let mentions = [];
          const rem = m[2].trim();
          if (rem) {
            if (rem === "@all" && chatId.endsWith("@g.us")) {
              const md = await sock.groupMetadata(chatId).catch(()=>null);
              mentions = md ? md.participants.map(p => p.id) : [];
            } else {
              mentions = rem.split(/\s+/).filter(t=>t.startsWith("@")).map(t=>{
                let id = t.replace(/^@/,"");
                if (!id.includes("@")) id += "@s.whatsapp.net";
                return id;
              });
            }
          }
          handleStartCommand(chatId, d, mentions, sock);
        }
      }
    }
  });
}

/**
 * Inițializează configurația bot-ului
 */
async function initializeBotConfig(sock) {
  if (global.botConfig.sendType) {
    setupCommands(sock);
    return;
  }

  let sendType = await askQuestion("Ce vrei să trimiți? (mesaje/poze): ");
  sendType = sendType.toLowerCase();
  if (sendType !== "mesaje" && sendType !== "poze") {
    console.error(chalk.red("Opțiune invalidă!"));
    process.exit(1);
  }
  global.botConfig.sendType = sendType;

  if (sendType === "mesaje") {
    const textPath = await askQuestion(
      "Calea către fișierul .txt (conținut full, cu linii și spații): "
    );
    if (!fs.existsSync(textPath)) {
      console.error(chalk.red("⛔ Fișierul nu există!"));
      process.exit(1);
    }
    // Citim întregul text, păstrăm spații și newline-uri
    global.botConfig.fullMessage = fs.readFileSync(textPath, "utf8");
    global.botConfig.textPath = textPath;
  } else {
    const photoPath = await askQuestion("Calea către fișierul foto: ");
    if (!fs.existsSync(photoPath)) {
      console.error(chalk.red("⛔ Fișierul foto nu există!"));
      process.exit(1);
    }
    global.botConfig.photoBuffer = fs.readFileSync(photoPath);
    global.botConfig.photoCaption = await askQuestion("Caption (optional): ");
  }

  global.botConfig.defaultDelay = 5000;
  console.log(chalk.red("\n✔ Configurare finalizată."));
  console.log(
    chalk.red(
      "👑 SCRIPTUL este gata! Folosește /start, /stop, /groupname, /stopgroupname, /add, /kick, .vv 👑"
    )
  );

  global.configReady = true;
  setupCommands(sock);
  resumeActiveSessions(sock);
}

/**
 * Pornește bot-ul WhatsApp cu reconectare robustă
 */
async function startBot() {
  // Pre-check DNS
  try {
    await checkDNS();
  } catch (err) {
    console.log(chalk.red("❌ DNS nu rezolvă web.whatsapp.com. Așteptăm..."));
    await waitForInternet();
    return startBot();
  }

  console.log(chalk.red("🔍 Pornire bot WhatsApp..."));

  // Alegere metodă de conectare
  if (!global.connectionMethod) {
    console.log(chalk.red("=============================="));
    console.log(chalk.red("   Alege metoda de conectare:"));
    console.log(chalk.red("   1. Cod de asociere"));
    console.log(chalk.red("   2. Cod QR"));
    console.log(chalk.red("=============================="));
    global.connectionMethod = await askQuestion("Numărul metodei (1 sau 2): ");
  }
  const choice = global.connectionMethod;

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  let sock;

  // Metoda 1: pairing code
  if (choice === "1") {
    sock = makeWASocket({
      auth: state,
      logger: Pino({ level: "silent" }),
      connectTimeoutMs: 60000,
    });

    if (!sock.authState.creds.registered) {
      const phoneNumber = await askQuestion("Număr de telefon (ex: 40756469325): ");
      global.owner = normalizeJid(
        phoneNumber.includes("@") ? phoneNumber : `${phoneNumber}@s.whatsapp.net`
      );
      try {
        const pairingCode = await sock.requestPairingCode(phoneNumber);
        console.log(chalk.red(`Cod de asociere: ${pairingCode}`));
      } catch (e) {
        console.error(chalk.red("Eroare pairing code:"), e);
      }
    } else {
      if (!global.owner && sock.user?.id) {
        global.owner = normalizeJid(sock.user.id);
      }
    }

  // Metoda 2: QR code
  } else if (choice === "2") {
    sock = makeWASocket({
      auth: state,
      logger: Pino({ level: "silent" }),
      connectTimeoutMs: 60000,
      printQRInTerminal: false,
    });

    sock.ev.on("connection.update", (upd) => {
      if (upd.qr) {
        console.clear();
        console.log(
          chalk.red(
            "\nScanează codul QR cu telefonul (WhatsApp > Linked Devices > Link a Device):\n"
          )
        );
        qrcode.generate(upd.qr, { small: true });
      }
    });
  } else {
    console.error(chalk.red("Opțiune invalidă!"));
    process.exit(1);
  }

  // WebSocket error handler
  sock.ws.on("error", async (err) => {
    if (err.code === "ENOTFOUND") {
      console.log(chalk.red("❌ WebSocket ENOTFOUND – Așteptăm reconectarea..."));
      await waitForInternet();
      return startBot();
    } else {
      console.error(chalk.red("❌ WebSocket error caught:"), err);
    }
  });

  // Connection updates & reconnect logic
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    const code = lastDisconnect?.error?.output?.statusCode;
    const msg = lastDisconnect?.error?.message || "";
    const stale = msg.includes("ENOTFOUND");

    if (connection === "open") {
      console.log(chalk.red("✔ Conectat la WhatsApp!"));
      if (global.botConfig.sendType) {
        setupCommands(sock);
        resumeActiveSessions(sock);
      } else {
        await initializeBotConfig(sock);
      }
    }

    if (connection === "close") {
      console.log(chalk.red("⏳ Conexiunea a fost pierdută."));
      if (code !== DisconnectReason.loggedOut || stale) {
        await waitForInternet();
        console.log(chalk.red("🔁 Reîncercăm reconectarea..."));
        try {
          await startBot();
        } catch (e) {
          console.error(chalk.red("❌ Eroare la reconectare:"), e);
          setTimeout(startBot, 10000);
        }
      } else {
        console.log(chalk.red("⇌ Deconectare definitivă. Restart manual necesar."));
        process.exit(1);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// Global error handlers
process.on("uncaughtException", (err) => {
  console.error(chalk.red("❌ uncaughtException:"), err);
});
process.on("unhandledRejection", (reason) => {
  console.error(chalk.red("❌ unhandledRejection:"), reason);
});

// Start the bot
startBot();
