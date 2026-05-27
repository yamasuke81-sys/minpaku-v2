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
  sendNotificationEmail_,
} = require("../utils/lineNotify");
const { buildIcsEvent } = require("../utils/icsBuilder");
const { addRecruitmentToActiveStaff, removeRecruitmentFromStaff, removeRecruitmentFromAllStaff } = require("../utils/inactiveStaff");
const { shouldDeferRecruitStart } = require("../utils/recruitDeferral");

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
          // 30日繰延フラグ (物件別 channelOverrides.recruit_start.deferUntil30Days) が ON で
          // 作業日が 30日超なら通知をスキップし notifyDeferred を立てる
          if (shouldDeferRecruitStart(propertyOverrides, data.checkoutDate)) {
            await docRef.update({
              notifyDeferred: true,
              notifyDeferredReason: "within30Days",
              updatedAt: FieldValue.serverTimestamp(),
            });
            console.log(`手動募集 ${docRef.id}: 30日繰延 (作業日=${data.checkoutDate})`);
          } else {
          const appUrl = (settings && settings.appUrl) || process.env.APP_BASE_URL || "https://minpaku-v2.web.app";
          // タップで該当募集の詳細モーダルを直接開けるよう recruitmentId 付き
          const recruitUrl = `${appUrl.replace(/\/$/, "")}/#/my-recruitment/${docRef.id}`;
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
          // 確定スタッフが該当募集の詳細モーダルを直接開けるよう recruitmentId 付きで遷移
          const dashUrl = `${appUrl.replace(/\/$/, "")}/#/my-recruitment/${req.params.id}`;
          const staffSnap = await db.collection("staff").where("active", "==", true).get();
          // 確定スタッフ全員の表示名を ID 順で組み立て (テンプレ {staff} 用)
          const idToName = new Map();
          staffSnap.docs.forEach(d => idToName.set(d.id, d.data().name || ""));
          const allConfirmedNames = hasIdList
            ? selectedIds.map(id => idToName.get(id) || "").filter(Boolean).join("、")
            : selectedNames.join("、");
          const work = data.workType === "pre_inspection" ? "直前点検" : "清掃";
          const text = `✅ ${work}確定のお知らせ\n\n${data.checkoutDate} ${data.propertyName || ""}\n担当: ${allConfirmedNames}\nよろしくお願いします。\n詳細: ${dashUrl}`;
          const confirmVars = {
            date: data.checkoutDate,
            checkoutDate: data.checkoutDate,
            property: data.propertyName || "",
            propertyName: data.propertyName || "",
            staff: allConfirmedNames,
            work,
            workType: data.workType || "cleaning",
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

          // 物件マスタ取得 (senderGmail + 作業時刻)
          let propertySenderGmail = "";
          let propertyData = {};
          try {
            const pDoc = await db.collection("properties").doc(data.propertyId).get();
            if (pDoc.exists) {
              propertyData = pDoc.data();
              propertySenderGmail = (propertyData.senderGmail || "").trim();
            }
          } catch (_) {}
          // ICS イベントの開始/終了時刻を物件マスタから決定
          // - 清掃: cleaningStartTime || baseWorkTime.start || "10:30" / 終了は baseWorkTime.end (なければ +cleaningDuration分 or +90分)
          // - 直前点検: inspectionStartTime || "10:00" / 終了は +60分
          const baseStart = propertyData.baseWorkTime?.start || "";
          const baseEnd = propertyData.baseWorkTime?.end || "";
          const _icsStartTime = data.workType === "pre_inspection"
            ? (propertyData.inspectionStartTime || "10:00")
            : (propertyData.cleaningStartTime || baseStart || "10:30");
          let _icsEndTime;
          if (data.workType === "pre_inspection") {
            // +60分
            const [h, m] = _icsStartTime.split(":").map(Number);
            const total = h * 60 + m + 60;
            _icsEndTime = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
          } else if (baseEnd) {
            _icsEndTime = baseEnd;
          } else {
            // cleaningDuration 分後 (なければ 90分)
            const dur = Number(propertyData.cleaningDuration) > 0 ? Number(propertyData.cleaningDuration) : 90;
            const [h, m] = _icsStartTime.split(":").map(Number);
            const total = h * 60 + m + dur;
            _icsEndTime = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
          }

          // 確定スタッフ本人のみに staffLine 個別送信 + (任意) ICS 添付メール
          for (const staffDoc of staffSnap.docs) {
            const sd = staffDoc.data();
            const isSelected = hasIdList
              ? selectedIds.includes(staffDoc.id)
              : selectedNames.includes(sd.name);
            if (!isSelected) continue;
            if (sd.lineUserId) {
              await notifyStaff(db, staffDoc.id, "staff_confirm",
                `確定: ${data.checkoutDate}`, text,
                {
                  ...confirmVars,
                  staffName: sd.name, // 受信者本人の名前（個別呼びかけ用）
                });
            }
            // ICS 添付メール (calendarInviteEnabled が default(undefined) または true なら送信)
            if (sd.email && sd.calendarInviteEnabled !== false && propertySenderGmail) {
              try {
                const workLabel = data.workType === "pre_inspection" ? "直前点検" : "清掃";
                const ics = buildIcsEvent({
                  uid: `${workLabel === "清掃" ? "cleaning" : "inspection"}-${recruitmentId}-${staffDoc.id}@minpaku-v2`,
                  date: data.checkoutDate,
                  startTime: _icsStartTime,
                  endTime: _icsEndTime,
                  summary: `${workLabel}: ${data.propertyName || ""}`,
                  description: `担当: ${data.selectedStaff || ""}\n時間: ${_icsStartTime}〜${_icsEndTime}\nWebアプリ: ${dashUrl}`,
                  location: data.propertyName || "",
                  calName: `${workLabel}シフト (${sd.name || ""})`,
                });
                const mailSubject = `${workLabel}担当確定 ${data.checkoutDate} / ${data.propertyName || ""}`;
                const mailBody = `${sd.name || ""} 様\n\n${text}\n\n──\n本メールには .ics ファイルが添付されています。\nGoogle カレンダー等で「予定を追加」していただくと、 確定日が自動でカレンダーに登録されます。`;
                await sendNotificationEmail_(sd.email, mailSubject, mailBody, propertySenderGmail, {
                  strictFrom: false,
                  attachments: [{
                    filename: `${workLabel}_${data.checkoutDate}.ics`,
                    contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
                    content: ics,
                  }],
                });
                console.log(`[staff_confirm] ICS 添付メール送信成功: ${sd.email}`);
              } catch (e) {
                console.warn(`[staff_confirm] ICS 添付メール失敗 (${sd.email}):`, e.message);
              }
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
  /**
   * 募集通知の即時再送 (オーナー専用)
   * - 募集詳細モーダルから手動で発火
   * - recruit_start 通知 (清掃 or 直前点検) を改めて発射
   * - 既存の回答・選定状態は一切変更しない
   */
  router.post("/:id/notify", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "募集が見つかりません" });
      const r = doc.data();

      const { settings } = await getNotificationSettings_(db);
      const appUrl = settings?.appUrl || process.env.APP_BASE_URL || "https://minpaku-v2.web.app";
      const recruitUrl = `${appUrl.replace(/\/$/, "")}/#/my-recruitment/${req.params.id}`;
      const work = r.workType === "pre_inspection" ? "直前点検" : "清掃";
      const propertyName = r.propertyName || "";
      const memo = r.memo || "";

      const result = await notifyByKey(db, "recruit_start", {
        title: `${work}スタッフ募集: ${r.checkoutDate}`,
        body: `🧹 ${work}スタッフ募集\n${r.checkoutDate} ${propertyName}\n${memo}\n回答: ${recruitUrl}`,
        vars: {
          date: r.checkoutDate,
          checkoutDate: r.checkoutDate,
          property: propertyName,
          propertyName,
          work,
          url: recruitUrl,
          memo,
        },
        propertyId: r.propertyId || null,
        // 手動「募集通知」ボタンはバッチ(朝8時/夜20時)をバイパスして必ず即時送信
        // notifyByKey 内で _fromBatchQueue=true を見るとバッチ enqueue 分岐をスキップして
        // 即時送信フローに進むため、ここで指定する
        _fromBatchQueue: true,
      });

      res.json({ message: `${work}募集通知を再送しました`, result });
    } catch (e) {
      console.error("募集通知再送エラー:", e);
      res.status(500).json({ error: e.message || "募集通知の再送に失敗しました" });
    }
  });

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
      const recruitUrl = `${appUrl.replace(/\/$/, "")}/#/my-recruitment/${recruitmentId}`;
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

      let recruitRows, candidateRows;
      try {
        const [r1, r2] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "募集" }),
          sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "募集_立候補" }),
        ]);
        recruitRows = r1.data.values || [];
        candidateRows = r2.data.values || [];
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
      // 立候補側の "rN" の N は募集シートの「シート行番号」を指す (GAS の仕様)
      // 予約行番号列ではない点に注意
      const recIdIdx = idxOf(recHeaders, "募集ID", "ID");
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

      // 3. v2 staff 取得 → 苗字マップ + フルネームマップ
      const staffSnap = await db.collection("staff").get();
      const lastNameMap = new Map();
      const fullNameMap = new Map(); // 名前(スペース除去) -> [{id, name, email}]
      const allStaff = [];
      staffSnap.forEach((d) => {
        const data = d.data();
        if (data.active === false) return;
        const name = String(data.name || "").trim();
        if (!name) return;
        const lastName = name.split(/[ 　]/)[0];
        if (!lastName) return;
        const entry = { id: d.id, name, email: data.email || "", lastName };
        allStaff.push(entry);
        if (!lastNameMap.has(lastName)) lastNameMap.set(lastName, []);
        lastNameMap.get(lastName).push(entry);
        const normFull = name.replace(/[\s 　]/g, "");
        if (!fullNameMap.has(normFull)) fullNameMap.set(normFull, []);
        fullNameMap.get(normFull).push(entry);
      });
      // 名前 (フル/苗字) → staff 解決
      const resolveStaff = (rawName) => {
        const s = String(rawName || "").trim();
        if (!s) return null;
        const norm = s.replace(/[\s 　]/g, "");
        const byFull = fullNameMap.get(norm) || [];
        if (byFull.length === 1) return byFull[0];
        const ln = s.split(/[ 　]/)[0];
        const byLast = lastNameMap.get(ln) || [];
        if (byLast.length === 1) return byLast[0];
        return null; // 0件 or 複数候補
      };

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

      // GAS の記号 → v2 の response 値
      const symbolMap = { "○": "◎", "◎": "◎", "△": "△", "×": "×", "✕": "×", "X": "×", "x": "×" };

      const _skip = () => { skipped++; };

      for (let i = 1; i < candidateRows.length; i++) {
        const row = candidateRows[i];
        const recId = String(row[candRecIdIdx] || "").trim();
        const gasName = String(row[candNameIdx] || "").trim();
        const rawStatus = String(row[candStatusIdx] || "").trim();
        const memo = candMemoIdx >= 0 ? String(row[candMemoIdx] || "").trim() : "";
        const respDate = candDateIdx >= 0 ? String(row[candDateIdx] || "").trim() : "";

        if (!recId || !gasName || !rawStatus) { _skip("empty_row", { rowIndex: i + 1, recId, gasName, rawStatus }); continue; }

        // 募集ID → 日付
        const date = resolveDate(recId);
        if (!date) { _skip("unknown_recId", { rowIndex: i + 1, recId, gasName }); continue; }
        if (date < from || date > to) { _skip("date_out_of_range", { rowIndex: i + 1, recId, date }); continue; }

        // v2 recruitment
        const recList = recByDate.get(date) || [];
        if (recList.length === 0) {
          warnings.push({ type: "no_recruitment", date, gasStaffName: gasName });
          _skip("no_recruitment", { rowIndex: i + 1, date, gasName });
          continue;
        }
        const recruitment = recList[0];

        // 苗字照合
        const lastName = gasName.split(/[ 　]/)[0];
        const candidates = lastNameMap.get(lastName) || [];
        if (candidates.length === 0) {
          warnings.push({ type: "no_match", gasStaffName: gasName, lastName });
          _skip("no_match", { rowIndex: i + 1, gasName, lastName });
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
          _skip("duplicate_lastname", { rowIndex: i + 1, gasName, lastName });
          continue;
        }
        const staff = candidates[0];

        // response 値マップ
        const response = symbolMap[rawStatus] || null;
        if (!response) { _skip("unknown_symbol", { rowIndex: i + 1, gasName, rawStatus }); continue; }

        // v2 は recruitments.{id}.responses[] 配列フィールドを使う
        const responsesArr = Array.isArray(recruitment.responses) ? [...recruitment.responses] : [];
        const existingIdx = responsesArr.findIndex((r) =>
          (r.staffId && r.staffId === staff.id) ||
          (r.staffName && r.staffName === staff.name)
        );
        // 既存が gas-import 系なら上書き、それ以外(人手入力)はスキップ
        if (existingIdx >= 0) {
          const existingSrc = responsesArr[existingIdx].source || "";
          if (!/^gas-import/.test(existingSrc)) {
            warnings.push({
              type: "v2_existing",
              staffId: staff.id,
              staffName: staff.name,
              date,
              recruitmentId: recruitment.id,
            });
            _skip();
            continue;
          }
        }

        matched++;
        const entry = {
          staffId: staff.id,
          staffName: staff.name,
          staffEmail: staff.email || "",
          response,
          memo: response === "△" ? memo : "",
          respondedAt: (parseRespondedAt_(respDate) || new Date()).toISOString(),
          source: "gas-import",
        };
        if (existingIdx >= 0) responsesArr[existingIdx] = entry;
        else responsesArr.push(entry);
        preview.push({
          date, recruitmentId: recruitment.id,
          staffId: staff.id, staffName: staff.name,
          response, memo: entry.memo,
          gasStaffName: gasName,
        });

        if (!dryRun) {
          // 過去 subcollection のゴミがあれば削除 (一度限り)
          const oldSub = await db.collection("recruitments").doc(recruitment.id)
            .collection("responses").get();
          for (const d of oldSub.docs) {
            if (/^gas-import/.test(d.data().source || "")) await d.ref.delete();
          }
          await db.collection("recruitments").doc(recruitment.id).update({
            responses: responsesArr,
            updatedAt: FieldValue.serverTimestamp(),
          });
          // ローカルの recruitment オブジェクトも更新 (確定ループ用)
          recruitment.responses = responsesArr;
          imported++;
        }
      }

      // ========== 確定状況のインポート (募集シートから) ==========
      const recDateIdxR = recDateIdx;
      const recStatusIdx = idxOf(recHeaders, "ステータス", "状態");
      const recSelectedIdx = idxOf(recHeaders, "選定スタッフ", "確定スタッフ");
      const confirmResults = []; // 確定インポート結果
      const confirmWarnings = [];
      let confirmedCount = 0;

      if (recStatusIdx >= 0 && recSelectedIdx >= 0) {
        for (let i = 1; i < recruitRows.length; i++) {
          const row = recruitRows[i];
          const date = normalizeDate_(row[recDateIdxR]);
          if (!date || date < from || date > to) continue;
          const status = String(row[recStatusIdx] || "").trim();
          const selectedRaw = String(row[recSelectedIdx] || "").trim();
          // 「スタッフ確定済」「確定」を含むもののみ対象
          if (!/確定/.test(status)) continue;
          if (!selectedRaw) continue;

          // v2 recruitment 検索 (同日複数あれば最初のものに反映)
          const recList = recByDate.get(date) || [];
          if (recList.length === 0) {
            confirmWarnings.push({ type: "no_recruitment", date, selected: selectedRaw });
            continue;
          }
          const recruitment = recList[0];

          // 選定スタッフ名 → staffId 解決 (カンマ/読点区切り)
          const namesRaw = selectedRaw.split(/[、,／/]/).map((s) => s.trim()).filter(Boolean);
          const selectedStaffIds = [];
          const selectedStaffNames = [];
          const unresolved = [];
          for (const nm of namesRaw) {
            // 「タイミー」等の特殊名は除外 (v2 では staff 化されていない場合あり)
            const st = resolveStaff(nm);
            if (st) {
              selectedStaffIds.push(st.id);
              selectedStaffNames.push(st.name);
            } else {
              unresolved.push(nm);
              selectedStaffNames.push(nm); // 名前は文字列のまま残す
            }
          }
          if (unresolved.length > 0) {
            confirmWarnings.push({ type: "unresolved_staff", date, names: unresolved, recruitmentId: recruitment.id });
          }

          confirmResults.push({
            date, recruitmentId: recruitment.id, selectedStaff: selectedStaffNames.join(","),
            selectedStaffIds, currentStatus: recruitment.status,
          });

          if (!dryRun) {
            const alreadyConfirmed = recruitment.status === "スタッフ確定済み";
            // 確定スタッフに ◎ 回答が無ければ配列に追加 (v2 標準形式)
            const arr = Array.isArray(recruitment.responses) ? [...recruitment.responses] : [];
            for (const sid of selectedStaffIds) {
              const idx = arr.findIndex((r) => r.staffId === sid);
              const sObj = allStaff.find((s) => s.id === sid);
              const entry = {
                staffId: sid,
                staffName: sObj ? sObj.name : "",
                staffEmail: sObj ? sObj.email : "",
                response: "◎",
                memo: "",
                respondedAt: new Date().toISOString(),
                source: "gas-import-confirm",
              };
              if (idx < 0) arr.push(entry);
              else if (/^gas-import/.test(arr[idx].source || "")) arr[idx] = entry;
              // 人手入力の既存回答はそのまま (確定済みなら ◎ のはず)
            }
            // 既確定なら responses 補完のみ。未確定なら status/selectedStaff も更新
            const updates = { responses: arr, updatedAt: FieldValue.serverTimestamp() };
            if (!alreadyConfirmed) {
              updates.status = "スタッフ確定済み";
              updates.selectedStaff = selectedStaffNames.join(",");
              updates.selectedStaffIds = selectedStaffIds;
              updates.confirmedAt = FieldValue.serverTimestamp();
            }
            await db.collection("recruitments").doc(recruitment.id).update(updates);
            // ローカルにも反映 (後続ループ用)
            recruitment.responses = arr;
            confirmedCount++;
          }
        }
      } else {
        confirmWarnings.push({ type: "no_status_or_selected_column" });
      }

      res.json({
        summary: {
          matched, imported, skipped, totalCandidateRows: candidateRows.length - 1,
          confirmedTargets: confirmResults.length,
          confirmedApplied: confirmedCount,
        },
        warnings: [...warnings, ...confirmWarnings],
        preview: dryRun ? preview : preview.slice(0, 50),
        confirmPreview: dryRun ? confirmResults : confirmResults.slice(0, 50),
        dryRun: !!dryRun,
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
