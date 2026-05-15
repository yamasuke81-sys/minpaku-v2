/**
 * 募集管理 API
 * 募集CRUD + スタッフ回答 + 選定・確定 + LINE通知
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const {
  notifyStaff, notifyGroup, notifyOwner,
  notifyByKey, buildRecruitmentFlex, resolveNotifyTargets, getNotificationSettings_,
} = require("../utils/lineNotify");
const { addRecruitmentToActiveStaff, removeRecruitmentFromStaff, removeRecruitmentFromAllStaff } = require("../utils/inactiveStaff");

module.exports = function recruitmentApi(db) {
  const router = Router();
  const collection = db.collection("recruitments");

  // 募集一覧取得（回答データ含む）
  router.get("/", async (req, res) => {
    try {
      const statusFilter = req.query.status;
      let query = collection.orderBy("checkoutDate", "desc");
      if (statusFilter) {
        query = query.where("status", "==", statusFilter);
      }
      const snapshot = await query.get();
      const list = [];
      for (const doc of snapshot.docs) {
        const data = { id: doc.id, ...doc.data() };
        // サブコレクションから回答取得
        const respSnap = await collection.doc(doc.id).collection("responses").get();
        data.responses = respSnap.docs.map((r) => ({ id: r.id, ...r.data() }));
        list.push(data);
      }
      res.json(list);
    } catch (e) {
      console.error("募集一覧取得エラー:", e);
      res.status(500).json({ error: "募集一覧の取得に失敗しました" });
    }
  });

  // 募集詳細取得
  router.get("/:id", async (req, res) => {
    try {
      const doc = await collection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const data = { id: doc.id, ...doc.data() };
      const respSnap = await collection.doc(doc.id).collection("responses").get();
      data.responses = respSnap.docs.map((r) => ({ id: r.id, ...r.data() }));
      res.json(data);
    } catch (e) {
      console.error("募集取得エラー:", e);
      res.status(500).json({ error: "募集の取得に失敗しました" });
    }
  });

  // 募集作成
  router.post("/", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const data = validateRecruitmentData(req.body);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }
      data.createdAt = FieldValue.serverTimestamp();
      data.updatedAt = FieldValue.serverTimestamp();
      const docRef = await collection.add(data);

      // LINE通知送信（非同期、エラーでもAPIは成功とする）
      // 注: bookingId が紐付く募集は onBookingChange トリガー側で recruit_start を送るため
      //     ここでは bookingId が無い手動作成のケースのみ通知する（二重送信防止）
      try {
        const shouldNotify = !data.bookingId;
        const { settings } = await getNotificationSettings_(db);
        // 物件別オーバーライドを取得
        let propertyOverrides = {};
        if (data.propertyId) {
          const propDoc = await db.collection("properties").doc(data.propertyId).get();
          if (propDoc.exists) propertyOverrides = propDoc.data().channelOverrides || {};
        }
        if (shouldNotify) {
          const appUrl = (settings && settings.appUrl) || process.env.APP_BASE_URL || "https://minpaku-v2.web.app";
          const recruitUrl = `${appUrl.replace(/\/$/, "")}/#/my-recruitment`;
          const work = data.workType === "pre_inspection" ? "直前点検" : "清掃";
          const baseVars = {
            date: data.checkoutDate,
            checkoutDate: data.checkoutDate,
            property: data.propertyName || "",
            propertyName: data.propertyName || "",
            work,
            url: recruitUrl,
            memo: data.memo || "",
          };
          // notifyByKey で ownerLine/groupLine/staffLine を一括送信 (recruit_start)
          await notifyByKey(db, "recruit_start", {
            title: `募集: ${data.checkoutDate}`,
            body: `🧹 ${work}スタッフ募集\n${data.checkoutDate} ${data.propertyName || ""}\n回答: ${recruitUrl}`,
            vars: baseVars,
            propertyId: data.propertyId || null,
          });
        }
      } catch (notifyErr) {
        console.error("募集通知エラー（無視）:", notifyErr);
      }

      // E: pendingRecruitmentIds 更新
      try { await addRecruitmentToActiveStaff(db, docRef.id); } catch (e) { console.error("addRecruitmentToActiveStaff エラー:", e); }

      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("募集作成エラー:", e);
      res.status(500).json({ error: "募集の作成に失敗しました" });
    }
  });

  // 募集更新
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const data = validateRecruitmentData(req.body, true);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }
      data.updatedAt = FieldValue.serverTimestamp();
      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("募集更新エラー:", e);
      res.status(500).json({ error: "募集の更新に失敗しました" });
    }
  });

  // 募集削除
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      // staff の pendingRecruitmentIds から除去してから削除
      await removeRecruitmentFromAllStaff(db, req.params.id);
      // サブコレクションの回答も削除
      const respSnap = await docRef.collection("responses").get();
      const batch = db.batch();
      respSnap.docs.forEach((r) => batch.delete(r.ref));
      batch.delete(docRef);
      await batch.commit();
      res.json({ message: "募集を削除しました" });
    } catch (e) {
      console.error("募集削除エラー:", e);
      res.status(500).json({ error: "募集の削除に失敗しました" });
    }
  });

  // スタッフ回答（◎/△/×）— Upsert
  router.post("/:id/respond", async (req, res) => {
    try {
      const recruitRef = collection.doc(req.params.id);
      const recruitDoc = await recruitRef.get();
      if (!recruitDoc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const recruitData = recruitDoc.data();
      if (recruitData.status === "スタッフ確定済み") {
        return res.status(400).json({ error: "この募集はスタッフ確定済みです" });
      }
      const { staffId, staffName, staffEmail, response, memo } = req.body;
      if (!staffName) {
        return res.status(400).json({ error: "スタッフ名は必須です" });
      }
      if (!["◎", "△", "×"].includes(response)) {
        return res.status(400).json({ error: "無効な回答です。◎/△/×で回答してください" });
      }
      // E: 非アクティブスタッフは回答不可
      if (staffId) {
        try {
          const sDoc = await db.collection("staff").doc(staffId).get();
          if (sDoc.exists && sDoc.data().active === false) {
            return res.status(403).json({
              error: sDoc.data().inactiveReason ||
                "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はWebアプリ管理者までご連絡ください。",
              inactive: true,
            });
          }
        } catch (_) {}
      }
      // Upsert: staffIdまたはstaffEmailで既存回答を検索
      const respColl = recruitRef.collection("responses");
      let existingDoc = null;
      if (staffId) {
        const byId = await respColl.where("staffId", "==", staffId).get();
        if (!byId.empty) existingDoc = byId.docs[0];
      }
      if (!existingDoc && staffEmail) {
        const byEmail = await respColl.where("staffEmail", "==", staffEmail).get();
        if (!byEmail.empty) existingDoc = byEmail.docs[0];
      }
      const responseData = {
        staffId: staffId || "",
        staffName: staffName,
        staffEmail: staffEmail || "",
        response: response,
        memo: memo || "",
        respondedAt: FieldValue.serverTimestamp(),
      };
      if (existingDoc) {
        await existingDoc.ref.update(responseData);
      } else {
        await respColl.add(responseData);
      }
      // E: pendingRecruitmentIds から除去
      try {
        if (staffId) await removeRecruitmentFromStaff(db, staffId, req.params.id);
      } catch (e) { console.error("removeRecruitmentFromStaff エラー:", e); }
      if (existingDoc) {
        res.json({ id: existingDoc.id, updated: true, ...responseData });
      } else {
        res.status(201).json({ ok: true, ...responseData });
      }
    } catch (e) {
      console.error("回答エラー:", e);
      res.status(500).json({ error: "回答の送信に失敗しました" });
    }
  });

  // 回答取消
  router.delete("/:id/respond/:responseId", async (req, res) => {
    try {
      const respRef = collection.doc(req.params.id).collection("responses").doc(req.params.responseId);
      const respDoc = await respRef.get();
      if (!respDoc.exists) {
        return res.status(404).json({ error: "回答が見つかりません" });
      }
      await respRef.delete();
      res.json({ message: "回答を取り消しました" });
    } catch (e) {
      console.error("回答取消エラー:", e);
      res.status(500).json({ error: "回答の取り消しに失敗しました" });
    }
  });

  // スタッフ選定（Webアプリ管理者のみ）
  router.put("/:id/select", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const { selectedStaff, selectedStaffIds } = req.body;
      await docRef.update({
        selectedStaff: selectedStaff || "",
        selectedStaffIds: selectedStaffIds || [],
        status: selectedStaff ? "選定済" : "募集中",
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "スタッフを選定しました" });
    } catch (e) {
      console.error("スタッフ選定エラー:", e);
      res.status(500).json({ error: "スタッフの選定に失敗しました" });
    }
  });

  // 募集確定（Webアプリ管理者のみ）
  router.put("/:id/confirm", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const data = doc.data();
      // selectedStaffIds が空配列または未定義なら確定不可
      const ids = data.selectedStaffIds;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "スタッフが選択されていません" });
      }
      await docRef.update({
        status: "スタッフ確定済み",
        confirmedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // 確定スタッフにLINE通知
      try {
        const selectedIds = data.selectedStaffIds || [];
        const selectedNames = (data.selectedStaff || "").split(",").map(s => s.trim()).filter(Boolean);
        const hasIdList = selectedIds.length > 0;

        if (hasIdList || selectedNames.length > 0) {
          // 確定通知用の appUrl + dashboard URL
          let appUrl = "https://minpaku-v2.web.app";
          try {
            const { settings } = await getNotificationSettings_(db);
            appUrl = settings?.appUrl || appUrl;
          } catch (_) { /* デフォルトで続行 */ }
          const dashUrl = `${appUrl.replace(/\/$/, "")}/#/my-dashboard`;
          const staffSnap = await db.collection("staff").where("active", "==", true).get();
          // 確定スタッフ全員の表示名を ID 順で組み立て (テンプレ {staff} 用)
          const idToName = new Map();
          staffSnap.docs.forEach(d => idToName.set(d.id, d.data().name || ""));
          const allConfirmedNames = hasIdList
            ? selectedIds.map(id => idToName.get(id) || "").filter(Boolean).join("、")
            : selectedNames.join("、");
          const text = `✅ 清掃確定のお知らせ\n\n${data.checkoutDate} ${data.propertyName || ""}\n担当: ${allConfirmedNames}\nよろしくお願いします。\n詳細: ${dashUrl}`;
          const confirmVars = {
            date: data.checkoutDate,
            checkoutDate: data.checkoutDate,
            property: data.propertyName || "",
            propertyName: data.propertyName || "",
            staff: allConfirmedNames,
            url: dashUrl,
          };

          // ownerLine/groupLine/ownerEmail/subOwner系 は notifyByKey で一括 (staffLine は除外)
          // staffLine は確定者本人のみに個別送信するため現行ロジックを維持
          await notifyByKey(db, "staff_confirm", {
            title: `確定: ${data.checkoutDate}`,
            body: text,
            vars: confirmVars,
            propertyId: data.propertyId || null,
            staffIds: [], // staffLine を notifyByKey に送らせない（空配列で全スタッフ送信を抑止）
          });

          // 確定スタッフ本人のみに staffLine 個別送信
          for (const staffDoc of staffSnap.docs) {
            const sd = staffDoc.data();
            const isSelected = hasIdList
              ? selectedIds.includes(staffDoc.id)
              : selectedNames.includes(sd.name);
            if (isSelected && sd.lineUserId) {
              await notifyStaff(db, staffDoc.id, "staff_confirm",
                `確定: ${data.checkoutDate}`, text,
                {
                  ...confirmVars,
                  staffName: sd.name, // 受信者本人の名前（個別呼びかけ用）
                });
            }
          }
        }
      } catch (notifyErr) {
        console.error("確定通知エラー（無視）:", notifyErr);
      }

      // shift upsert: propertyId + checkoutDate + workType で検索し、なければ作成・あれば更新
      // 【修正3】workType 条件を追加 — 同日に清掃と直前点検が両方ある場合に互いを上書きしないようにする
      // 変更前: propertyId + date のみで検索 → 異なる workType の shift を誤って上書きしていた
      // 変更後: workType も条件に加えて正しい shift のみ更新する
      try {
        const targetWorkType = data.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count";
        const shiftSnap = await db.collection("shifts")
          .where("propertyId", "==", data.propertyId)
          .where("date", "==", new Date(data.checkoutDate))
          .where("workType", "==", targetWorkType)
          .limit(1)
          .get();

        // property から cleaningStartTime を取得
        let cleaningStartTime = "10:30";
        if (data.propertyId) {
          try {
            const propDoc = await db.collection("properties").doc(data.propertyId).get();
            if (propDoc.exists) cleaningStartTime = propDoc.data().cleaningStartTime || "10:30";
          } catch (_) { /* デフォルトで続行 */ }
        }

        const firstStaffId = (data.selectedStaffIds || [])[0] || null;
        const firstStaffName = (data.selectedStaff || "").split(",")[0]?.trim() || null;

        if (shiftSnap.empty) {
          // 新規作成 → onShiftCreated トリガーが発火して checklist 自動生成
          await db.collection("shifts").add({
            date: new Date(data.checkoutDate),
            propertyId: data.propertyId,
            propertyName: data.propertyName || "",
            bookingId: data.bookingId || null,
            workType: data.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count",
            staffId: firstStaffId,
            staffName: firstStaffName,
            staffIds: data.selectedStaffIds || [],
            startTime: cleaningStartTime,
            status: "assigned",
            assignMethod: "manual_confirm",
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          console.log(`shift 新規作成: propertyId=${data.propertyId}, date=${data.checkoutDate}`);
        } else {
          // 既存を更新
          await shiftSnap.docs[0].ref.update({
            staffId: firstStaffId,
            staffName: firstStaffName,
            staffIds: data.selectedStaffIds || [],
            status: "assigned",
            assignMethod: "manual_confirm",
            updatedAt: FieldValue.serverTimestamp(),
          });
          console.log(`shift 更新: ${shiftSnap.docs[0].id}`);
        }
      } catch (shiftErr) {
        console.error("shift upsert エラー（確定は継続）:", shiftErr);
      }

      res.json({ message: "スタッフを確定しました" });
    } catch (e) {
      console.error("募集確定エラー:", e);
      res.status(500).json({ error: "募集の確定に失敗しました" });
    }
  });

  // 募集再開（確定解除）
  router.put("/:id/reopen", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      await docRef.update({
        status: "募集中",
        confirmedAt: null,
        // 確定取消時は選定スタッフもクリア (残ると「未回答なのに選定済み」 表示の不整合になる)
        selectedStaff: "",
        selectedStaffIds: [],
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "募集を再開しました" });
    } catch (e) {
      console.error("募集再開エラー:", e);
      res.status(500).json({ error: "募集の再開に失敗しました" });
    }
  });

  /**
   * 清掃日変更通知 (UI から呼ばれる、recruitment.checkoutDate は UI 側で既に更新済み)
   * - 既回答スタッフに recruit_date_change 通知 (新日付・旧日付を変数で渡す)
   * - 全スタッフに recruit_start 通知 (変更後の日付について再募集)
   * Body: { recruitmentId, oldDate, newDate }
   */
  router.post("/notify-date-change", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const { recruitmentId, oldDate, newDate } = req.body || {};
      if (!recruitmentId || !oldDate || !newDate) {
        return res.status(400).json({ error: "recruitmentId / oldDate / newDate 必須" });
      }
      const docRef = collection.doc(recruitmentId);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "募集が見つかりません" });
      const r = doc.data();

      const { settings } = await getNotificationSettings_(db);
      const appUrl = settings?.appUrl || "https://minpaku-v2.web.app";
      const recruitUrl = `${appUrl}/#/my-recruitment`;
      const propertyName = r.propertyName || "";
      const responses = Array.isArray(r.responses) ? r.responses : [];

      // 1) 既回答スタッフに日付変更通知 (個別 LINE)
      const respondedStaffIds = [...new Set(responses.map(rr => rr.staffId).filter(Boolean))];
      let staffNotified = 0;
      for (const sid of respondedStaffIds) {
        try {
          await notifyStaff(db, sid, "recruit_date_change",
            `清掃日が変更されました: ${oldDate} → ${newDate}`,
            `【清掃日変更】\n${propertyName}\n旧: ${oldDate}\n新: ${newDate}\n\n以前の回答はクリアされました。新しい日付で改めて回答をお願いします。\n${recruitUrl}`,
            { date: newDate, oldDate, property: propertyName, url: recruitUrl, work: "清掃" },
            {} // propertyOverrides
          );
          staffNotified++;
        } catch (e) {
          console.warn(`日付変更通知 staff=${sid} 失敗:`, e.message);
        }
      }

      // 2) recruit_start 通知 (変更後の日付について再募集)
      try {
        const memo = r.memo || "";
        await notifyByKey(db, "recruit_start", {
          title: `清掃スタッフ募集: ${newDate} (日程変更)`,
          body: `【清掃スタッフ募集 (日程変更)】\n${newDate} ${propertyName}\n${memo}\n※ ${oldDate} → ${newDate} に変更されました。\n回答: ${recruitUrl}`,
          vars: {
            date: newDate, property: propertyName, work: "清掃",
            url: recruitUrl, memo, note: `※ ${oldDate} → ${newDate} に変更されました。`,
          },
          propertyId: r.propertyId || null,
        });
      } catch (e) {
        console.warn("recruit_start 通知失敗:", e.message);
      }

      res.json({
        message: `日付変更通知を送信しました (既回答 ${staffNotified}名 + 全スタッフ募集通知)`,
        respondedStaffNotified: staffNotified,
      });
    } catch (e) {
      console.error("日付変更通知エラー:", e);
      res.status(500).json({ error: e.message || "日付変更通知に失敗しました" });
    }
  });

  // ========================================================================
  // GAS版スタッフ回答データ取込 (一度きりの繋ぎツール / オーナー専用)
  // 旧 GAS の「募集」「募集_立候補」シートを読み、v2 recruitments/{id}/responses に反映する
  // ========================================================================
  router.post("/import-gas-responses", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const { from, to, propertyId, dryRun = true } = req.body || {};
      if (!from || !to) return res.status(400).json({ error: "from / to は必須です" });
      if (!propertyId) return res.status(400).json({ error: "propertyId は必須です" });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: "from / to は YYYY-MM-DD 形式で指定してください" });
      }

      const SHEET_ID = "1Kk8VZrMQoJwmNk4OZKVQ9riufiCEcVPi_xmYHHnHgCs";

      // 1. Sheets API でシート読み取り
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      });
      const sheets = google.sheets({ version: "v4", auth });

      let recruitRows, candidateRows, allSheetNames = [];
      const sheetPreviews = {}; // 怪しいシート名 → 先頭10行
      try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
        allSheetNames = (meta.data.sheets || []).map((s) => s.properties.title);
        const [r1, r2] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "募集" }),
          sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "募集_立候補" }),
        ]);
        recruitRows = r1.data.values || [];
        candidateRows = r2.data.values || [];

        // 怪しいシート (回答/履歴/集計/共有関連) の先頭10行を取得
        const targetNames = allSheetNames.filter((n) =>
          /回答|履歴|集計|共有|スタッフ|募集設定|通知|サブオーナー/.test(n)
        );
        for (const name of targetNames) {
          try {
            const resp = await sheets.spreadsheets.values.get({
              spreadsheetId: SHEET_ID,
              range: `'${name}'!A1:Z10`,
            });
            sheetPreviews[name] = resp.data.values || [];
          } catch (e) {
            sheetPreviews[name] = [["(取得失敗: " + e.message + ")"]];
          }
        }
      } catch (e) {
        console.error("Sheets API 読取失敗:", e);
        return res.status(502).json({ error: `スプシ読取失敗: ${e.message}` });
      }
      if (recruitRows.length < 2) return res.status(400).json({ error: "募集シートにデータがありません" });
      if (candidateRows.length < 2) return res.status(400).json({ error: "募集_立候補シートにデータがありません" });

      // ヘッダー → 列インデックス map
      const idxOf = (headers, ...names) => {
        for (const n of names) {
          const i = headers.findIndex((h) => String(h || "").trim() === n);
          if (i >= 0) return i;
        }
        return -1;
      };
      const recHeaders = recruitRows[0].map((h) => String(h || "").trim());
      const candHeaders = candidateRows[0].map((h) => String(h || "").trim());

      const recDateIdx = idxOf(recHeaders, "日付", "CO日", "チェックアウト日", "checkoutDate");
      const recIdIdx = idxOf(recHeaders, "募集ID", "予約行番号", "行番号", "ID");
      if (recDateIdx < 0) {
        return res.status(400).json({ error: "募集シートに『日付』列が見つかりません" });
      }

      const candRecIdIdx = idxOf(candHeaders, "募集ID", "ID");
      const candNameIdx = idxOf(candHeaders, "スタッフ名", "氏名", "名前");
      const candStatusIdx = idxOf(candHeaders, "ステータス", "回答", "状況");
      const candMemoIdx = idxOf(candHeaders, "メモ", "保留理由", "理由", "備考");
      const candDateIdx = idxOf(candHeaders, "日時", "回答日時");
      if (candRecIdIdx < 0 || candNameIdx < 0 || candStatusIdx < 0) {
        return res.status(400).json({
          error: `募集_立候補シートに必要な列がありません (募集ID/スタッフ名/ステータス)。ヘッダー: ${candHeaders.join(",")}`,
        });
      }

      // 2. 募集シート: 募集ID -> 日付 マップ作成
      //    両側で「数字部分のみ」のキーも作る (立候補は "r5" 形式、募集側は "5" 等のため)
      const recIdToDate = new Map();
      for (let i = 1; i < recruitRows.length; i++) {
        const row = recruitRows[i];
        const date = normalizeDate_(row[recDateIdx]);
        if (!date) continue;
        const id = recIdIdx >= 0 ? String(row[recIdIdx] || "").trim() : String(i + 1);
        if (id) {
          recIdToDate.set(id, date);
          // 数字部分のみのキーも登録
          const digits = id.replace(/[^0-9]/g, "");
          if (digits && digits !== id) recIdToDate.set(digits, date);
        }
      }
      // recId 解決ヘルパー: そのまま → 数字のみ の順で参照
      const resolveDate = (rawRecId) => {
        const s = String(rawRecId || "").trim();
        if (!s) return null;
        if (recIdToDate.has(s)) return recIdToDate.get(s);
        const digits = s.replace(/[^0-9]/g, "");
        if (digits && recIdToDate.has(digits)) return recIdToDate.get(digits);
        return null;
      };

      // 3. v2 staff 取得 → 苗字マップ (lastName -> [{id, name}])
      const staffSnap = await db.collection("staff").get();
      const lastNameMap = new Map();
      const allStaff = [];
      staffSnap.forEach((d) => {
        const data = d.data();
        if (data.active === false) return;
        const name = String(data.name || "").trim();
        if (!name) return;
        const lastName = name.split(/[ 　]/)[0];
        if (!lastName) return;
        const entry = { id: d.id, name, lastName };
        allStaff.push(entry);
        if (!lastNameMap.has(lastName)) lastNameMap.set(lastName, []);
        lastNameMap.get(lastName).push(entry);
      });

      // 4. v2 recruitments を propertyId で取得しメモリ内で期間フィルタ
      //    (複合 index 不要にするため。recruitments は物件あたり数百件以内の想定)
      const recSnap = await db.collection("recruitments")
        .where("propertyId", "==", propertyId)
        .get();
      const recByDate = new Map(); // date -> [{id, ...}]
      recSnap.forEach((d) => {
        const data = { id: d.id, ...d.data() };
        const date = data.checkoutDate;
        if (!date) return;
        if (date < from || date > to) return;
        if (!recByDate.has(date)) recByDate.set(date, []);
        recByDate.get(date).push(data);
      });

      // 5. 候補行を走査
      const warnings = [];
      const preview = [];
      let matched = 0;
      let imported = 0;
      let skipped = 0;
      const skipReasons = {
        empty_row: 0,
        unknown_recId: 0,
        date_out_of_range: 0,
        no_recruitment: 0,
        no_match: 0,
        duplicate_lastname: 0,
        unknown_symbol: 0,
        v2_existing: 0,
      };
      const skipSamples = []; // 先頭10件のスキップ理由詳細

      // GAS の記号 → v2 の response 値
      const symbolMap = { "○": "◎", "◎": "◎", "△": "△", "×": "×", "✕": "×", "X": "×", "x": "×" };

      const recordSkip = (reason, info) => {
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
        if (skipSamples.length < 10) skipSamples.push({ reason, ...info });
        skipped++;
      };

      for (let i = 1; i < candidateRows.length; i++) {
        const row = candidateRows[i];
        const recId = String(row[candRecIdIdx] || "").trim();
        const gasName = String(row[candNameIdx] || "").trim();
        const rawStatus = String(row[candStatusIdx] || "").trim();
        const memo = candMemoIdx >= 0 ? String(row[candMemoIdx] || "").trim() : "";
        const respDate = candDateIdx >= 0 ? String(row[candDateIdx] || "").trim() : "";

        if (!recId || !gasName || !rawStatus) { recordSkip("empty_row", { rowIndex: i + 1, recId, gasName, rawStatus }); continue; }

        // 募集ID → 日付
        const date = resolveDate(recId);
        if (!date) { recordSkip("unknown_recId", { rowIndex: i + 1, recId, gasName }); continue; }
        if (date < from || date > to) { recordSkip("date_out_of_range", { rowIndex: i + 1, recId, date }); continue; }

        // v2 recruitment
        const recList = recByDate.get(date) || [];
        if (recList.length === 0) {
          warnings.push({ type: "no_recruitment", date, gasStaffName: gasName });
          recordSkip("no_recruitment", { rowIndex: i + 1, date, gasName });
          continue;
        }
        const recruitment = recList[0];

        // 苗字照合
        const lastName = gasName.split(/[ 　]/)[0];
        const candidates = lastNameMap.get(lastName) || [];
        if (candidates.length === 0) {
          warnings.push({ type: "no_match", gasStaffName: gasName, lastName });
          recordSkip("no_match", { rowIndex: i + 1, gasName, lastName });
          continue;
        }
        if (candidates.length > 1) {
          warnings.push({
            type: "duplicate_lastname",
            gasStaffName: gasName,
            lastName,
            candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
            recruitmentId: recruitment.id,
            date,
          });
          recordSkip("duplicate_lastname", { rowIndex: i + 1, gasName, lastName });
          continue;
        }
        const staff = candidates[0];

        // response 値マップ
        const response = symbolMap[rawStatus] || null;
        if (!response) { recordSkip("unknown_symbol", { rowIndex: i + 1, gasName, rawStatus }); continue; }

        // v2 既存 response 確認
        const existing = await db.collection("recruitments").doc(recruitment.id)
          .collection("responses").doc(staff.id).get();
        if (existing.exists) {
          warnings.push({
            type: "v2_existing",
            staffId: staff.id,
            staffName: staff.name,
            date,
            recruitmentId: recruitment.id,
          });
          recordSkip("v2_existing", { rowIndex: i + 1, staffName: staff.name, date });
          continue;
        }

        matched++;
        const responseDoc = {
          staffId: staff.id,
          staffName: staff.name,
          response,
          memo: response === "△" ? memo : "",
          respondedAt: parseRespondedAt_(respDate) || FieldValue.serverTimestamp(),
          source: "gas-import",
        };
        preview.push({
          date, recruitmentId: recruitment.id,
          staffId: staff.id, staffName: staff.name,
          response, memo: responseDoc.memo,
          gasStaffName: gasName,
        });

        if (!dryRun) {
          await db.collection("recruitments").doc(recruitment.id)
            .collection("responses").doc(staff.id).set(responseDoc, { merge: true });
          imported++;
        }
      }

      // 募集ID列を自動探索: 立候補側の recId と一致する値が最も多い募集シート列を探す
      const candRecIdSet = new Set();
      const candRecIdDigitsSet = new Set();
      for (let i = 1; i < candidateRows.length; i++) {
        const v = String(candidateRows[i][candRecIdIdx] || "").trim();
        if (v) {
          candRecIdSet.add(v);
          const dg = v.replace(/[^0-9]/g, "");
          if (dg) candRecIdDigitsSet.add(dg);
        }
      }
      const colMatchScore = []; // { colIdx, header, exactHits, digitsHits, sampleValues }
      const colCount = recHeaders.length;
      for (let c = 0; c < colCount; c++) {
        let exact = 0, digits = 0;
        const sampleVals = [];
        for (let i = 1; i < recruitRows.length; i++) {
          const v = String((recruitRows[i][c] !== undefined ? recruitRows[i][c] : "")).trim();
          if (!v) continue;
          if (sampleVals.length < 5) sampleVals.push(v);
          if (candRecIdSet.has(v)) exact++;
          const dg = v.replace(/[^0-9]/g, "");
          if (dg && candRecIdDigitsSet.has(dg)) digits++;
        }
        colMatchScore.push({ colIdx: c, header: recHeaders[c] || `(col${c})`, exactHits: exact, digitsHits: digits, sampleValues: sampleVals });
      }
      colMatchScore.sort((a, b) => (b.exactHits + b.digitsHits) - (a.exactHits + a.digitsHits));

      // 範囲内の募集日付 (debug 用)
      const recDatesInRange = [];
      for (const [id, d] of recIdToDate.entries()) {
        if (d >= from && d <= to) recDatesInRange.push({ recId: id, date: d });
      }
      const v2RecDates = Array.from(recByDate.keys()).sort();

      // 範囲内の募集シート行を全列出力 (debug 用 — 募集ID 列特定のため)
      const recRowsInRange = [];
      for (let i = 1; i < recruitRows.length; i++) {
        const row = recruitRows[i];
        const d = normalizeDate_(row[recDateIdx]);
        if (!d || d < from || d > to) continue;
        const dump = {};
        for (let c = 0; c < row.length; c++) {
          const header = recHeaders[c] || `(col${c})`;
          dump[`${c}:${header}`] = row[c];
        }
        recRowsInRange.push({ sheetRow: i + 1, dump });
      }

      // 立候補シートで範囲内日付に該当する recId サンプル (もし date 解決できれば)
      const candSamplesInRange = [];
      for (let i = 1; i < candidateRows.length && candSamplesInRange.length < 20; i++) {
        const row = candidateRows[i];
        const recId = String(row[candRecIdIdx] || "").trim();
        const d = resolveDate(recId);
        if (d && d >= from && d <= to) {
          candSamplesInRange.push({ rowIndex: i + 1, recId, date: d, name: row[candNameIdx], status: row[candStatusIdx] });
        }
      }

      res.json({
        summary: { matched, imported, skipped, totalCandidateRows: candidateRows.length - 1 },
        warnings,
        preview: dryRun ? preview : preview.slice(0, 50),
        dryRun: !!dryRun,
        debug: {
          recHeaders, candHeaders,
          recDateIdx, recIdIdx, candRecIdIdx, candNameIdx, candStatusIdx, candMemoIdx,
          skipReasons,
          skipSamples,
          recDatesInRange,
          v2RecDates,
          v2RecCount: recSnap.size,
          recRowsInRange,
          candSamplesInRange,
          colMatchScore: colMatchScore.slice(0, 5),
          allSheetNames,
          sheetPreviews,
          allCandRecIds: Array.from(candRecIdSet).sort(),
        },
      });
    } catch (e) {
      console.error("GAS取込エラー:", e);
      res.status(500).json({ error: e.message || "GAS取込に失敗しました" });
    }
  });

  return router;
};

// 日付正規化: "2026/05/01" / "2026-05-01" / Date オブジェクト相当 → "YYYY-MM-DD"
function normalizeDate_(v) {
  if (!v) return "";
  const s = String(v).trim();
  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // YYYY/MM/DD
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // M/D/YYYY (Sheets が稀に返す)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}

// 回答日時パース (失敗時 null)
function parseRespondedAt_(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * 募集データのバリデーション
 */
function validateRecruitmentData(body, isUpdate = false) {
  const data = {};
  if (!isUpdate && !body.checkoutDate) {
    return { error: "チェックアウト日は必須です" };
  }
  if (!isUpdate && !body.propertyId) {
    return { error: "propertyIdは必須です" };
  }
  if (body.checkoutDate !== undefined) data.checkoutDate = String(body.checkoutDate).trim();
  if (body.propertyId !== undefined) data.propertyId = String(body.propertyId).trim();
  if (body.propertyName !== undefined) data.propertyName = String(body.propertyName).trim();
  if (body.bookingId !== undefined) data.bookingId = String(body.bookingId).trim();
  if (body.status !== undefined) data.status = String(body.status).trim();
  if (body.selectedStaff !== undefined) data.selectedStaff = String(body.selectedStaff).trim();
  if (body.notifyMethod !== undefined) data.notifyMethod = String(body.notifyMethod).trim();
  if (body.memo !== undefined) data.memo = String(body.memo).trim();
  // 次回予約情報
  if (body.nextReservation !== undefined) data.nextReservation = body.nextReservation;
  // 新規登録時デフォルト値
  if (!isUpdate) {
    if (!data.status) data.status = "募集中";
    if (!data.notifyMethod) data.notifyMethod = "メール";
    if (!data.selectedStaff) data.selectedStaff = "";
  }
  return data;
}
