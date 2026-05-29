/**
 * スタッフ管理 API
 * CRUD + 一覧取得 + 報酬単価明示書 PDF
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

// CJK フォント (invoices.js と同じパターン)
const BUNDLED_CJK_FONT = path.join(__dirname, "../fonts/NotoSansJP-Regular.ttf");
const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJKjp-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
];
function findCjkFont_() {
  if (fs.existsSync(BUNDLED_CJK_FONT)) return BUNDLED_CJK_FONT;
  for (const p of CJK_FONT_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function fmtYen_(n) {
  return Number(n || 0).toLocaleString("ja-JP");
}

module.exports = function staffApi(db) {
  const router = Router();
  const collection = db.collection("staff");

  // スタッフ一覧取得
  router.get("/", async (req, res) => {
    try {
      const activeOnly = req.query.active !== "false";
      let query = collection.orderBy("displayOrder", "asc");
      if (activeOnly) {
        query = query.where("active", "==", true);
      }
      const snapshot = await query.get();
      const staff = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(staff);
    } catch (e) {
      console.error("スタッフ一覧取得エラー:", e);
      res.status(500).json({ error: "スタッフ一覧の取得に失敗しました" });
    }
  });

  // スタッフ詳細取得
  router.get("/:id", async (req, res) => {
    try {
      const doc = await collection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }
      res.json({ id: doc.id, ...doc.data() });
    } catch (e) {
      console.error("スタッフ取得エラー:", e);
      res.status(500).json({ error: "スタッフの取得に失敗しました" });
    }
  });

  // スタッフ登録
  router.post("/", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const data = validateStaffData(req.body);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }

      data.createdAt = FieldValue.serverTimestamp();
      data.updatedAt = FieldValue.serverTimestamp();

      const docRef = await collection.add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("スタッフ登録エラー:", e);
      res.status(500).json({ error: "スタッフの登録に失敗しました" });
    }
  });

  // スタッフ更新
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }

      const data = validateStaffData(req.body, true);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }

      data.updatedAt = FieldValue.serverTimestamp();
      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("スタッフ更新エラー:", e);
      res.status(500).json({ error: "スタッフの更新に失敗しました" });
    }
  });

  // FCMトークン登録（本人のみ自分のスタッフdocにトークン追加）
  router.post("/:id/fcm-token", async (req, res) => {
    try {
      const targetStaffId = req.params.id;
      // Webアプリ管理者は全員分更新可。スタッフは自分のみ
      if (req.user.role !== "owner" && req.user.staffId !== targetStaffId) {
        return res.status(403).json({ error: "自分のトークンのみ登録できます" });
      }

      const { token } = req.body;
      if (!token || typeof token !== "string") {
        return res.status(400).json({ error: "tokenが必要です" });
      }

      const ref = collection.doc(targetStaffId);
      const doc = await ref.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }

      // fcmTokens配列に追加（重複しない）
      await ref.update({
        fcmTokens: FieldValue.arrayUnion(token),
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json({ success: true });
    } catch (e) {
      console.error("FCMトークン登録エラー:", e);
      res.status(500).json({ error: "FCMトークンの登録に失敗しました" });
    }
  });

  // FCMトークン削除（本人またはWebアプリ管理者）
  router.delete("/:id/fcm-token", async (req, res) => {
    try {
      const targetStaffId = req.params.id;
      if (req.user.role !== "owner" && req.user.staffId !== targetStaffId) {
        return res.status(403).json({ error: "自分のトークンのみ削除できます" });
      }

      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ error: "tokenが必要です" });
      }

      await collection.doc(targetStaffId).update({
        fcmTokens: FieldValue.arrayRemove(token),
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json({ success: true });
    } catch (e) {
      console.error("FCMトークン削除エラー:", e);
      res.status(500).json({ error: "FCMトークンの削除に失敗しました" });
    }
  });

  // スタッフ 非アクティブ解除（active=true + pendingRecruitmentIds クリア）
  router.post("/:id/reactivate", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const ref = collection.doc(req.params.id);
      const d = await ref.get();
      if (!d.exists) return res.status(404).json({ error: "スタッフが見つかりません" });
      await ref.update({
        active: true,
        pendingRecruitmentIds: [],
        inactiveReason: "",
        inactivatedAt: null,
        reactivatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "スタッフを再アクティブ化しました" });
    } catch (e) {
      console.error("reactivate エラー:", e);
      res.status(500).json({ error: "再アクティブ化に失敗しました" });
    }
  });

  // スタッフ削除（論理削除: active=false）
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }

      // 論理削除
      await docRef.update({
        active: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "スタッフを無効化しました" });
    } catch (e) {
      console.error("スタッフ削除エラー:", e);
      res.status(500).json({ error: "スタッフの削除に失敗しました" });
    }
  });

  /**
   * 報酬単価明示書 PDF 生成
   * GET /staff/:id/rate-card-pdf
   * フリーランス法3条 (取適法) 対応の電磁的明示書 兼 業務委託契約締結時の添付資料
   */
  router.get("/:id/rate-card-pdf", async (req, res) => {
    try {
      if (req.user.role !== "owner" && req.user.role !== "sub_owner") {
        return res.status(403).json({ error: "権限がありません" });
      }

      const staffId = req.params.id;
      const staffDoc = await collection.doc(staffId).get();
      if (!staffDoc.exists) return res.status(404).json({ error: "スタッフが見つかりません" });
      const staff = { id: staffDoc.id, ...staffDoc.data() };

      // 委託者 (合同会社八朔) 情報 - settings/clientInfo を fallback で利用
      let client = {
        companyName: "合同会社八朔",
        representative: "西山 恭介",
        address: "広島県安芸郡海田町上市4番23号12",
        zipCode: "736-0061",
      };
      try {
        const ciDoc = await db.collection("settings").doc("clientInfo").get();
        if (ciDoc.exists) {
          const ci = ciDoc.data() || {};
          client = {
            companyName: ci.companyName || client.companyName,
            representative: ci.representative || ci.name || client.representative,
            address: ci.address || client.address,
            zipCode: ci.zipCode || client.zipCode,
          };
        }
      } catch (_) { /* 既定値を使う */ }

      // 物件一覧 (民泊・active のみ)
      const propSnap = await db.collection("properties")
        .where("active", "==", true)
        .get();
      const properties = propSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => (p.type || "minpaku") === "minpaku")
        .sort((a, b) => (a.propertyNumber || 0) - (b.propertyNumber || 0));

      // 物件ごとに propertyWorkItems を取得し、当該スタッフ適用単価を抽出
      const propRateData = [];
      for (const prop of properties) {
        const wiDoc = await db.collection("propertyWorkItems").doc(prop.id).get();
        if (!wiDoc.exists) continue;
        const items = (wiDoc.data().items || [])
          .slice()
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

        const rows = items.map(wi => {
          const rateMode = wi.rateMode || "common";
          let rateMap = {};
          let hasStaffSpecific = false;
          if (rateMode === "perStaff") {
            const sr = wi.staffRates?.[staffId];
            if (sr && typeof sr === "object") {
              rateMap = sr;
              hasStaffSpecific = true;
            } else {
              // 当該スタッフ未設定 → common にフォールバック
              rateMap = wi.commonRates || {};
            }
          } else {
            rateMap = wi.commonRates || {};
          }
          // 特別加算
          const specials = Array.isArray(wi.specialRates) ? wi.specialRates : [];
          return {
            name: wi.name || "",
            type: wi.type || "other",
            rateMode,
            hasStaffSpecific,
            rates: rateMap,
            specials,
          };
        }).filter(r => {
          // 単価未設定 (全部0) の項目は出さない
          const values = Object.values(r.rates || {}).map(v => Number(v) || 0);
          return values.some(v => v > 0);
        });

        if (rows.length > 0) {
          propRateData.push({ property: prop, rows });
        }
      }

      // PDF 生成
      const cjkFont = findCjkFont_();
      const pdfOpts = { margin: 40, size: "A4" };
      if (cjkFont) pdfOpts.font = cjkFont;
      const pdfDoc = new PDFDocument(pdfOpts);
      const buffers = [];
      pdfDoc.on("data", c => buffers.push(c));
      pdfDoc.on("end", () => {
        const buf = Buffer.concat(buffers);
        const filename = encodeURIComponent(`報酬単価明示書_${staff.name || staffId}.pdf`);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
        res.send(buf);
      });
      pdfDoc.on("error", (e) => {
        console.error("PDF生成エラー:", e);
        if (!res.headersSent) res.status(500).json({ error: "PDF生成に失敗しました" });
      });

      const setFont = (size = 10, bold = false) => {
        if (cjkFont) pdfDoc.font(cjkFont).fontSize(size);
        else pdfDoc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
      };

      const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const issuedDate = `${nowJst.getUTCFullYear()}年${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}月${String(nowJst.getUTCDate()).padStart(2, "0")}日`;
      const leftX = 40;
      const pageWidth = 515;

      // タイトル
      setFont(20);
      pdfDoc.text("報酬単価明示書", leftX, pdfDoc.y, { width: pageWidth, align: "center" });
      pdfDoc.moveDown(0.5);
      setFont(10);
      pdfDoc.text(`発行日：${issuedDate}`, leftX, pdfDoc.y, { width: pageWidth, align: "right" });
      pdfDoc.moveDown(1);

      // 宛先
      setFont(12);
      pdfDoc.text(`${staff.name || ""}　殿`, leftX, pdfDoc.y);
      pdfDoc.moveDown(1);

      // 前文
      setFont(10);
      pdfDoc.text(
        "本書は、貴殿と当社との間で締結する業務委託契約書第６条第１項に基づき、当社が貴殿に委託する業務に係る業務委託料の単価その他の支払条件を明示するものです。本書は、特定受託事業者に係る取引の適正化等に関する法律（フリーランス法）第３条に基づく明示書を兼ねます。",
        leftX, pdfDoc.y, { width: pageWidth, align: "left", lineGap: 2 }
      );
      pdfDoc.moveDown(1.2);

      // 物件ごとの単価表
      if (propRateData.length === 0) {
        setFont(10);
        pdfDoc.text("※ 現時点で貴殿に適用される単価が登録されている物件はありません。", leftX, pdfDoc.y);
        pdfDoc.moveDown(1);
      }

      for (const { property, rows } of propRateData) {
        // 改ページ判定
        if (pdfDoc.y > 700) pdfDoc.addPage();

        // 物件名
        setFont(13);
        pdfDoc.text(`■ 物件：${property.name}`, leftX, pdfDoc.y);
        pdfDoc.moveDown(0.4);

        // テーブルヘッダ
        const colX = { name: leftX, p1: leftX + 220, p2: leftX + 310, p3: leftX + 400 };
        const rowH = 18;
        setFont(9);
        const headerY = pdfDoc.y;
        pdfDoc.rect(leftX, headerY, pageWidth, rowH).fill("#E8F0FA").fillColor("black");
        pdfDoc.text("作業項目", colX.name + 4, headerY + 4, { width: 210 });
        pdfDoc.text("単価 (1名作業)", colX.p1, headerY + 4, { width: 86, align: "right" });
        pdfDoc.text("単価 (2名作業)", colX.p2, headerY + 4, { width: 86, align: "right" });
        pdfDoc.text("単価 (3名以上)", colX.p3, headerY + 4, { width: 110, align: "right" });
        pdfDoc.moveTo(leftX, headerY + rowH).lineTo(leftX + pageWidth, headerY + rowH).stroke();
        let curY = headerY + rowH;

        // データ行
        setFont(9);
        for (const r of rows) {
          if (curY > 760) { pdfDoc.addPage(); curY = 40; }
          const v1 = Number(r.rates[1] || 0);
          const v2 = Number(r.rates[2] || 0);
          const v3 = Number(r.rates[3] || 0);
          pdfDoc.rect(leftX, curY, pageWidth, rowH).stroke("#CCCCCC");
          pdfDoc.fillColor("black");
          const tag = r.hasStaffSpecific ? "  ※貴殿専用" : "";
          pdfDoc.text(`${r.name}${tag}`, colX.name + 4, curY + 4, { width: 210 });
          pdfDoc.text(v1 > 0 ? `¥${fmtYen_(v1)}` : "－", colX.p1, curY + 4, { width: 86, align: "right" });
          pdfDoc.text(v2 > 0 ? `¥${fmtYen_(v2)}` : "－", colX.p2, curY + 4, { width: 86, align: "right" });
          pdfDoc.text(v3 > 0 ? `¥${fmtYen_(v3)}` : "－", colX.p3, curY + 4, { width: 110, align: "right" });
          curY += rowH;

          // 特別加算 (この作業項目に紐付くもの)
          for (const sr of (r.specials || [])) {
            const add = Number(sr.addAmount || 0);
            if (add <= 0) continue;
            let label = sr.label || "特別加算";
            let period = "";
            if (sr.recurYearly) {
              period = `${sr.recurStart || "??"}〜${sr.recurEnd || "??"} (毎年)`;
            } else if (sr.start || sr.end) {
              period = `${sr.start || ""}〜${sr.end || ""}`;
            }
            if (curY > 760) { pdfDoc.addPage(); curY = 40; }
            pdfDoc.rect(leftX, curY, pageWidth, rowH).stroke("#EEEEEE");
            pdfDoc.fillColor("#555555");
            pdfDoc.text(`　└ ${label} (${period})`, colX.name + 4, curY + 4, { width: 360 });
            pdfDoc.text(`+¥${fmtYen_(add)}`, colX.p3, curY + 4, { width: 110, align: "right" });
            pdfDoc.fillColor("black");
            curY += rowH;
          }
        }

        pdfDoc.y = curY + 12;
      }

      // 支払条件
      if (pdfDoc.y > 680) pdfDoc.addPage();
      setFont(13);
      pdfDoc.text("■ 支払条件", leftX, pdfDoc.y);
      pdfDoc.moveDown(0.4);
      setFont(10);
      pdfDoc.text(
        "・締日：毎月末日（その月における業務遂行分を当月分として集計）\n" +
        "・支払期日：翌月末日までに、貴殿の指定する金融機関口座に振り込みます。\n" +
        "・振込手数料：当社負担\n" +
        "・適用税区分：消費税の取扱いは別途協議の上、決定します。",
        leftX, pdfDoc.y, { width: pageWidth, align: "left", lineGap: 2 }
      );
      pdfDoc.moveDown(1.2);

      // 注意書き
      setFont(9);
      pdfDoc.fillColor("#555555");
      pdfDoc.text(
        "※ 本書記載の単価は発行日時点のものです。経済事情その他の変動により改定する場合は、別途貴殿に通知のうえ協議いたします。\n" +
        "※ 同時作業人数による単価は、当社運用上の「1名作業」「2名作業」「3名以上作業」の人員区分に対応します。\n" +
        "※ 単価未設定の項目は「－」と表示しています。",
        leftX, pdfDoc.y, { width: pageWidth, align: "left", lineGap: 2 }
      );
      pdfDoc.fillColor("black");
      pdfDoc.moveDown(2);

      // 発行者
      if (pdfDoc.y > 720) pdfDoc.addPage();
      setFont(10);
      pdfDoc.text("【発行者】", leftX, pdfDoc.y);
      pdfDoc.moveDown(0.3);
      pdfDoc.text(`〒${client.zipCode}　${client.address}`, leftX, pdfDoc.y);
      pdfDoc.moveDown(0.3);
      pdfDoc.text(`${client.companyName}　代表社員　${client.representative}`, leftX, pdfDoc.y);

      pdfDoc.end();
    } catch (e) {
      console.error("単価明示書PDF生成エラー:", e);
      if (!res.headersSent) res.status(500).json({ error: e.message || "PDF生成に失敗しました" });
    }
  });

  return router;
};

/**
 * スタッフデータのバリデーション
 */
function validateStaffData(body, isUpdate = false) {
  const data = {};

  if (!isUpdate && !body.name) {
    return { error: "名前は必須です" };
  }

  if (body.name !== undefined) data.name = String(body.name).trim();
  if (body.email !== undefined) data.email = String(body.email).trim();
  if (body.phone !== undefined) data.phone = String(body.phone).trim();
  if (body.skills !== undefined) {
    data.skills = Array.isArray(body.skills) ? body.skills : [];
  }
  if (body.availableDays !== undefined) {
    data.availableDays = Array.isArray(body.availableDays) ? body.availableDays : [];
  }
  if (body.ratePerJob !== undefined) data.ratePerJob = Number(body.ratePerJob) || 0;
  if (body.transportationFee !== undefined) data.transportationFee = Number(body.transportationFee) || 0;
  if (body.bankName !== undefined) data.bankName = String(body.bankName).trim();
  if (body.branchName !== undefined) data.branchName = String(body.branchName).trim();
  if (body.accountType !== undefined) data.accountType = String(body.accountType).trim();
  if (body.accountNumber !== undefined) data.accountNumber = String(body.accountNumber).trim();
  if (body.accountHolder !== undefined) data.accountHolder = String(body.accountHolder).trim();
  if (body.contractStartDate !== undefined) data.contractStartDate = body.contractStartDate;
  // 電子契約 (GMOサイン)
  if (body.contractStatus !== undefined) {
    const allowed = ["none", "sent", "signed", "expired"];
    const v = String(body.contractStatus || "none");
    data.contractStatus = allowed.includes(v) ? v : "none";
  }
  if (body.contractSignedAt !== undefined) data.contractSignedAt = body.contractSignedAt || null;
  if (body.contractServiceDocId !== undefined) data.contractServiceDocId = String(body.contractServiceDocId || "").trim();
  if (body.contractUrl !== undefined) data.contractUrl = String(body.contractUrl || "").trim();
  if (body.contractMemo !== undefined) data.contractMemo = String(body.contractMemo || "").trim();
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.displayOrder !== undefined) data.displayOrder = Number(body.displayOrder) || 0;
  if (body.memo !== undefined) data.memo = String(body.memo).trim();
  // fcmTokensは配列（複数デバイス対応）
  if (body.fcmTokens !== undefined) {
    data.fcmTokens = Array.isArray(body.fcmTokens) ? body.fcmTokens : [];
  }

  // 新規登録時のデフォルト値
  if (!isUpdate) {
    if (data.active === undefined) data.active = true;
    if (data.displayOrder === undefined) data.displayOrder = 0;
    if (data.skills === undefined) data.skills = [];
    if (data.availableDays === undefined) data.availableDays = [];
  }

  return data;
}
