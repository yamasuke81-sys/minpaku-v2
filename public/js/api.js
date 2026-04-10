/**
 * API クライアント（Firestore直接接続版）
 * テストモード中はCloud Functionsを経由せず、直接Firestoreに読み書き
 */
const db = firebase.firestore();

const API = {
  // フィールド正規化（日本語ヘッダー→英語フィールド名）
  _normalizeStaff(s) {
    return {
      ...s,
      name: s.name || s["名前"] || "",
      email: s.email || s["メール"] || "",
      phone: s.phone || s["電話"] || "",
      bankName: s.bankName || s["金融機関名"] || "",
      branchName: s.branchName || s["支店名"] || "",
      accountType: s.accountType || s["口座種類"] || "普通",
      accountNumber: s.accountNumber || s["口座番号"] || "",
      accountHolder: s.accountHolder || s["口座名義"] || "",
      memo: s.memo || s["住所"] || "",
      active: s.active !== undefined ? s.active !== false && s.active !== "N" : (s["有効"] || "Y") !== "N",
      skills: s.skills || [],
      availableDays: s.availableDays || [],
      ratePerJob: s.ratePerJob || 0,
      transportationFee: s.transportationFee || 0,
      displayOrder: s.displayOrder || 0,
    };
  },

  // スタッフ API
  staff: {
    async list(activeOnly = true) {
      const snap = await db.collection("staff").get();
      let staff = snap.docs.map(doc => API._normalizeStaff({ id: doc.id, ...doc.data() }));
      // 名前が空のエントリを除外
      staff = staff.filter(s => s.name && s.name.trim());
      if (activeOnly) {
        staff = staff.filter(s => s.active !== false);
      }
      staff.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
      return staff;
    },

    async get(id) {
      const doc = await db.collection("staff").doc(id).get();
      if (!doc.exists) throw new Error("スタッフが見つかりません");
      return API._normalizeStaff({ id: doc.id, ...doc.data() });
    },

    async create(data) {
      data.active = data.active !== false;
      data.displayOrder = data.displayOrder || 0;
      data.skills = data.skills || [];
      data.availableDays = data.availableDays || [];
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("staff").add(data);
      return { id: ref.id, ...data };
    },

    async update(id, data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("staff").doc(id).update(data);
      return { id, ...data };
    },

    async delete(id) {
      await db.collection("staff").doc(id).update({
        active: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    },
  },

  // 物件 API
  properties: {
    async list(activeOnly = true) {
      const snap = await db.collection("properties").get();
      let properties = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (activeOnly) {
        properties = properties.filter(p => p.active !== false);
      }
      properties.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      return properties;
    },

    async get(id) {
      const doc = await db.collection("properties").doc(id).get();
      if (!doc.exists) throw new Error("物件が見つかりません");
      return { id: doc.id, ...doc.data() };
    },

    async create(data) {
      data.active = data.active !== false;
      data.type = data.type || "minpaku";
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("properties").add(data);
      return { id: ref.id, ...data };
    },

    async update(id, data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("properties").doc(id).update(data);
      return { id, ...data };
    },

    async delete(id) {
      await db.collection("properties").doc(id).update({
        active: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    },
  },

  // シフト API
  shifts: {
    async list(params = {}) {
      const snap = await db.collection("shifts").get();
      let shifts = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (params.from) {
        const fromDate = new Date(params.from);
        shifts = shifts.filter(s => {
          const d = s.date && s.date.toDate ? s.date.toDate() : new Date(s.date);
          return d >= fromDate;
        });
      }
      if (params.to) {
        const toDate = new Date(params.to);
        shifts = shifts.filter(s => {
          const d = s.date && s.date.toDate ? s.date.toDate() : new Date(s.date);
          return d <= toDate;
        });
      }
      if (params.staffId) shifts = shifts.filter(s => s.staffId === params.staffId);
      if (params.propertyId) shifts = shifts.filter(s => s.propertyId === params.propertyId);
      shifts.sort((a, b) => {
        const da = a.date && a.date.toDate ? a.date.toDate() : new Date(a.date || 0);
        const db2 = b.date && b.date.toDate ? b.date.toDate() : new Date(b.date || 0);
        return da - db2;
      });
      return shifts;
    },

    async create(data) {
      data.date = new Date(data.date);
      data.status = data.staffId ? "assigned" : "unassigned";
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("shifts").add(data);
      return { id: ref.id, ...data };
    },

    async update(id, data) {
      if (data.date) data.date = new Date(data.date);
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("shifts").doc(id).update(data);
      return { id, ...data };
    },

    async delete(id) {
      await db.collection("shifts").doc(id).delete();
    },
  },

  // ランドリー API
  laundry: {
    async list(params = {}) {
      const snap = await db.collection("laundry").get();
      let records = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (params.staffId) {
        records = records.filter(r => r.staffId === params.staffId);
      }
      if (params.yearMonth) {
        records = records.filter(r => {
          const d = r.date && r.date.toDate ? r.date.toDate() : new Date(r.date);
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          return ym === params.yearMonth;
        });
      }
      records.sort((a, b) => {
        const da = a.date && a.date.toDate ? a.date.toDate() : new Date(a.date || 0);
        const db2 = b.date && b.date.toDate ? b.date.toDate() : new Date(b.date || 0);
        return db2 - da;
      });
      return records;
    },

    async create(data) {
      data.date = new Date(data.date);
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("laundry").add(data);
      return { id: ref.id, ...data };
    },

    async delete(id) {
      await db.collection("laundry").doc(id).delete();
    },
  },

  // 請求書 API
  invoices: {
    async list(params = {}) {
      const snap = await db.collection("invoices").get();
      let invoices = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (params.yearMonth) invoices = invoices.filter(i => i.yearMonth === params.yearMonth);
      if (params.staffId) invoices = invoices.filter(i => i.staffId === params.staffId);
      invoices.sort((a, b) => (b.yearMonth || "").localeCompare(a.yearMonth || ""));
      return invoices;
    },

    async get(id) {
      const doc = await db.collection("invoices").doc(id).get();
      if (!doc.exists) throw new Error("請求書が見つかりません");
      return { id: doc.id, ...doc.data() };
    },

    async create(data) {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("invoices").add(data);
      return { id: ref.id, ...data };
    },

    async update(id, data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("invoices").doc(id).update(data);
    },

    async confirm(id) {
      await db.collection("invoices").doc(id).update({
        status: "confirmed",
        confirmedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    },

    async markPaid(id) {
      await db.collection("invoices").doc(id).update({
        status: "paid",
        paidAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    },

    async delete(id) {
      await db.collection("invoices").doc(id).delete();
    },

    /**
     * 月次請求書を自動生成
     * 募集データ（確定済み）+ ランドリー + スタッフ単価から集計
     */
    async generate(yearMonth) {
      const [ym0, ym1] = yearMonth.split("-").map(Number);
      const monthStart = yearMonth + "-01";
      const nextMonth = new Date(ym0, ym1, 1);
      const monthEnd = nextMonth.getFullYear() + "-" + String(nextMonth.getMonth() + 1).padStart(2, "0") + "-" + String(nextMonth.getDate()).padStart(2, "0");

      // 確定済み募集を取得（対象月）
      const allRecruitments = await API.recruitments.list();
      const monthRecruitments = allRecruitments.filter(r => {
        const d = (r.checkoutDate || "").slice(0, 10);
        return d >= monthStart && d < monthEnd && r.status === "スタッフ確定済み" && r.selectedStaff;
      });

      // ランドリー記録を取得
      const allLaundry = await API.laundry.list();
      const monthLaundry = allLaundry.filter(l => {
        const d = l.date && l.date.toDate ? l.date.toDate() : new Date(l.date || 0);
        const ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        return ds === yearMonth;
      });

      // スタッフ一覧
      const staffList = await API.staff.list(false);
      const staffMap = {};
      staffList.forEach(s => { staffMap[s.name] = s; staffMap[s.id] = s; });

      // スタッフ別に集計
      const staffAgg = {};

      // 募集→シフト集計
      monthRecruitments.forEach(r => {
        const names = (r.selectedStaff || "").split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
        names.forEach(name => {
          if (!staffAgg[name]) staffAgg[name] = { shifts: [], laundry: [], staffData: null };
          const s = staffMap[name];
          if (s) staffAgg[name].staffData = s;
          staffAgg[name].shifts.push({
            date: r.checkoutDate,
            propertyName: r.propertyName || "",
            amount: s ? (s.ratePerJob || 0) : 0,
          });
        });
      });

      // ランドリー集計
      monthLaundry.forEach(l => {
        const staff = staffMap[l.staffId];
        const name = staff ? staff.name : l.staffId;
        if (!staffAgg[name]) staffAgg[name] = { shifts: [], laundry: [], staffData: staff || null };
        staffAgg[name].laundry.push({
          date: l.date && l.date.toDate ? l.date.toDate().toISOString().slice(0, 10) : "",
          amount: l.amount || 0,
        });
      });

      // 既存の請求書を確認（重複防止）
      const existing = await API.invoices.list({ yearMonth });
      const existingStaffIds = new Set(existing.map(i => i.staffId));

      const created = [];
      for (const [name, agg] of Object.entries(staffAgg)) {
        const s = agg.staffData;
        const staffId = s ? s.id : name;

        if (existingStaffIds.has(staffId)) continue; // 既存スキップ

        const basePayment = agg.shifts.reduce((sum, sh) => sum + sh.amount, 0);
        const laundryFee = agg.laundry.reduce((sum, l) => sum + l.amount, 0);
        const transportationFee = s ? (s.transportationFee || 0) * agg.shifts.length : 0;
        const total = basePayment + laundryFee + transportationFee;

        if (total === 0 && agg.shifts.length === 0 && agg.laundry.length === 0) continue;

        const invoice = await API.invoices.create({
          yearMonth,
          staffId,
          staffName: name,
          basePayment,
          laundryFee,
          transportationFee,
          specialAllowance: 0,
          total,
          status: "draft",
          pdfUrl: null,
          confirmedAt: null,
          details: {
            shifts: agg.shifts,
            laundry: agg.laundry,
            shiftCount: agg.shifts.length,
            ratePerJob: s ? (s.ratePerJob || 0) : 0,
            transportPerShift: s ? (s.transportationFee || 0) : 0,
          },
        });
        created.push(invoice);
      }

      return { created: created.length, skipped: existingStaffIds.size, invoices: created };
    },
  },

  // 募集管理 API（回答はドキュメント内 responses[] に埋め込み — N+1クエリ解消）
  recruitments: {
    async list(statusFilter = null) {
      const snap = await db.collection("recruitments").get();
      let list = snap.docs.map(doc => {
        const data = { id: doc.id, ...doc.data() };
        data.responses = data.responses || [];
        return data;
      });
      if (statusFilter) list = list.filter(r => r.status === statusFilter);
      list.sort((a, b) => (b.checkoutDate || "").localeCompare(a.checkoutDate || ""));
      return list;
    },

    async get(id) {
      const doc = await db.collection("recruitments").doc(id).get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      const data = { id: doc.id, ...doc.data() };
      data.responses = data.responses || [];
      return data;
    },

    async create(data) {
      data.status = data.status || "募集中";
      data.notifyMethod = data.notifyMethod || "メール";
      data.selectedStaff = data.selectedStaff || "";
      data.responses = data.responses || [];
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("recruitments").add(data);
      return { id: ref.id, ...data };
    },

    async update(id, data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("recruitments").doc(id).update(data);
      return { id, ...data };
    },

    async delete(id) {
      await db.collection("recruitments").doc(id).delete();
    },

    // 回答をドキュメント内のresponses配列にUpsert
    async respond(recruitmentId, responseData) {
      const ref = db.collection("recruitments").doc(recruitmentId);
      const doc = await ref.get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      const rData = doc.data();
      if (rData.status === "スタッフ確定済み") {
        throw new Error("この募集はスタッフ確定済みです");
      }
      if (!["◎", "△", "×"].includes(responseData.response)) {
        throw new Error("無効な回答です。◎/△/×で回答してください");
      }
      const responses = rData.responses || [];
      const key = responseData.staffId || responseData.staffEmail || responseData.staffName;
      const idx = responses.findIndex(r =>
        (r.staffId && r.staffId === responseData.staffId) ||
        (r.staffEmail && r.staffEmail === responseData.staffEmail)
      );
      const entry = {
        ...responseData,
        respondedAt: new Date().toISOString(),
      };
      if (idx >= 0) {
        responses[idx] = entry;
      } else {
        responses.push(entry);
      }
      await ref.update({
        responses,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return { updated: idx >= 0, ...entry };
    },

    async cancelResponse(recruitmentId, staffId) {
      const ref = db.collection("recruitments").doc(recruitmentId);
      const doc = await ref.get();
      if (!doc.exists) return;
      const responses = (doc.data().responses || []).filter(r =>
        r.staffId !== staffId && r.staffEmail !== staffId
      );
      await ref.update({ responses, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    },

    async selectStaff(recruitmentId, selectedStaff) {
      const staff = (selectedStaff || "").trim();
      const update = {
        selectedStaff: staff,
        status: staff ? "選定済" : "募集中",
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (!staff) update.confirmedAt = null;
      await db.collection("recruitments").doc(recruitmentId).update(update);
    },

    async confirm(recruitmentId) {
      const doc = await db.collection("recruitments").doc(recruitmentId).get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      if (!doc.data().selectedStaff) throw new Error("スタッフが選定されていません");
      await db.collection("recruitments").doc(recruitmentId).update({
        status: "スタッフ確定済み",
        confirmedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    },

    async reopen(recruitmentId) {
      await db.collection("recruitments").doc(recruitmentId).update({
        status: "募集中",
        confirmedAt: null,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    },

    // 旧サブコレクションを埋め込みに一括移行
    async migrateResponsesToEmbedded() {
      const snap = await db.collection("recruitments").get();
      let migrated = 0;
      for (const doc of snap.docs) {
        const data = doc.data();
        if (data.responses && data.responses.length > 0) continue;
        const respSnap = await db.collection("recruitments").doc(doc.id).collection("responses").get();
        if (respSnap.empty) continue;
        const responses = respSnap.docs.map(r => ({ id: r.id, ...r.data() }));
        await db.collection("recruitments").doc(doc.id).update({ responses });
        // サブコレクションのドキュメントを削除
        const batch = db.batch();
        respSnap.docs.forEach(r => batch.delete(r.ref));
        await batch.commit();
        migrated++;
      }
      return migrated;
    },
  },

  // 宿泊者名簿 API
  guests: {
    async list(params = {}) {
      const snap = await db.collection("guestRegistrations").get();
      let list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (params.from) {
        list = list.filter(g => (g.checkIn || "") >= params.from);
      }
      if (params.to) {
        list = list.filter(g => (g.checkIn || "") <= params.to);
      }
      if (params.search) {
        const s = params.search.toLowerCase();
        list = list.filter(g =>
          (g.guestName || "").toLowerCase().includes(s) ||
          (g.guests || []).some(m => (m.name || "").toLowerCase().includes(s)) ||
          (g.nationality || "").toLowerCase().includes(s) ||
          (g.phone || "").includes(s)
        );
      }
      list.sort((a, b) => (b.checkIn || "").localeCompare(a.checkIn || ""));
      return list;
    },

    async get(id) {
      const doc = await db.collection("guestRegistrations").doc(id).get();
      if (!doc.exists) throw new Error("宿泊者情報が見つかりません");
      return { id: doc.id, ...doc.data() };
    },

    /**
     * 新規作成 or 同一CIの既存エントリにマージ
     * - 同一CIがあればマージ（実名>プレースホルダ、非空値優先）
     * - なければ新規作成
     */
    async create(data) {
      data.source = data.source || "manual";
      data.nationality = data.nationality || "日本";
      data.guests = data.guests || [];

      // 同一CIの既存エントリを検索
      if (data.checkIn) {
        const existing = await this._findByCheckIn(data.checkIn);
        if (existing) {
          // マージして更新
          const merged = this._mergeGuestData(existing, data);
          merged.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
          await db.collection("guestRegistrations").doc(existing.id).update(merged);
          return { id: existing.id, ...merged };
        }
      }

      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("guestRegistrations").add(data);
      return { id: ref.id, ...data };
    },

    async update(id, data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("guestRegistrations").doc(id).update(data);
      return { id, ...data };
    },

    // CI一致の既存エントリを検索（1物件1日1予約の原則）
    async _findByCheckIn(checkIn) {
      const snap = await db.collection("guestRegistrations")
        .where("checkIn", "==", checkIn).limit(5).get();
      if (snap.empty) return null;
      // 実名を優先して返す
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return docs.find(d => !this._isPlaceholder(d.guestName)) || docs[0];
    },

    _isPlaceholder(name) {
      if (!name) return true;
      const n = name.trim().toLowerCase();
      return !n || n === "-" ||
        n.includes("airbnb") || n.includes("booking.com") ||
        n.includes("not available") || n.includes("reserved") ||
        n.includes("closed") || n.includes("予約") || n.includes("blocked");
    },

    /**
     * マージルール:
     * 1. ゲスト名: 実名 > プレースホルダ
     * 2. 人数: フォーム入力値 > 既存値（0以外を優先）
     * 3. CO日: 両方有効なら後の日付（長い滞在）を優先
     * 4. その他: 空でない方を優先
     */
    _mergeGuestData(existing, incoming) {
      const merged = { ...existing };
      delete merged.id; // Firestore更新時にIDは不要

      // ゲスト名: 実名優先
      if (incoming.guestName && !this._isPlaceholder(incoming.guestName)) {
        merged.guestName = incoming.guestName;
      }

      // 人数: 0以外を優先、incoming（フォーム）を優先
      if (incoming.guestCount && incoming.guestCount > 0) {
        merged.guestCount = incoming.guestCount;
      }
      if (incoming.guestCountInfants !== undefined && incoming.guestCountInfants > 0) {
        merged.guestCountInfants = incoming.guestCountInfants;
      }

      // CO日: 両方有効なら後の日付を優先
      if (incoming.checkOut && existing.checkOut) {
        const existCo = new Date(existing.checkOut);
        const incomeCo = new Date(incoming.checkOut);
        const ci = new Date(incoming.checkIn || existing.checkIn);
        // CO > CI であること
        if (incomeCo > ci && existCo > ci) {
          merged.checkOut = incomeCo >= existCo ? incoming.checkOut : existing.checkOut;
          // CO不一致フラグ
          if (existing.checkOut !== incoming.checkOut) {
            merged._coMismatch = true;
            merged._coOriginal = existing.checkOut;
            merged._coIncoming = incoming.checkOut;
          }
        } else if (incomeCo > ci) {
          merged.checkOut = incoming.checkOut;
        }
      } else if (incoming.checkOut) {
        merged.checkOut = incoming.checkOut;
      }

      // その他: 空でない方（incoming優先）
      const fields = ["nationality", "address", "phone", "email", "passportNumber",
        "purpose", "bookingSite", "bbq", "parking", "memo"];
      for (const f of fields) {
        if (incoming[f] && incoming[f].trim()) {
          merged[f] = incoming[f];
        }
      }

      // 同行者: incoming側にあればそちらを採用
      if (incoming.guests && incoming.guests.length > 0) {
        merged.guests = incoming.guests;
      }

      // ソース
      if (incoming.source) merged.source = incoming.source;

      return merged;
    },

    async delete(id) {
      await db.collection("guestRegistrations").doc(id).delete();
    },
  },

  // 定期報告 API（住宅宿泊事業法14条）
  reports: {
    async periods() {
      const snap = await db.collection("reports").get();
      const reportMap = {};
      snap.docs.forEach((doc) => {
        reportMap[doc.id] = doc.data();
      });

      // 報告期間を生成
      const now = new Date();
      const year = now.getFullYear();
      const periods = [];
      for (let m = 2; m <= 12; m += 2) {
        const targetMonth1 = m - 2 || 12;
        const targetMonth2 = m - 1 || 1;
        const targetYear1 = m === 2 ? year - 1 : year;
        const targetYear2 = m === 2 ? year : year;
        const deadlineMonth = m + 1 > 12 ? 1 : m + 1;
        const deadlineYear = m + 1 > 12 ? year + 1 : year;
        const id = `${year}-${String(m).padStart(2, "0")}`;
        periods.push({
          id,
          targetMonths: [
            { year: targetYear1, month: targetMonth1 },
            { year: targetYear2, month: targetMonth2 },
          ],
          deadline: `${deadlineYear}-${String(deadlineMonth).padStart(2, "0")}-15`,
          label: `${targetYear1}年${targetMonth1}月・${targetYear2}年${targetMonth2}月`,
          submitted: !!reportMap[id]?.submittedAt,
          submittedAt: reportMap[id]?.submittedAt || null,
          memo: reportMap[id]?.memo || "",
        });
      }
      return periods;
    },

    async aggregate(year1, month1, year2, month2, periodId) {
      // guestRegistrations を取得
      const guestSnap = await db.collection("guestRegistrations").get();
      const rawGuests = guestSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      const bookingSnap = await db.collection("bookings").get();
      const bookings = bookingSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      const y1 = Number(year1), m1 = Number(month1);
      const y2 = Number(year2), m2 = Number(month2);
      const periodStart = `${y1}-${String(m1).padStart(2, "0")}-01`;
      const periodEndDate = new Date(y2, m2, 0);
      const periodEnd = `${y2}-${String(m2).padStart(2, "0")}-${String(periodEndDate.getDate()).padStart(2, "0")}`;

      const month1Data = { year: y1, month: m1, totalNights: 0, japanese: 0, foreign: 0, byNationality: {} };
      const month2Data = { year: y2, month: m2, totalNights: 0, japanese: 0, foreign: 0, byNationality: {} };
      const details = [];

      function calcNightsInMonth(checkIn, checkOut, year, month) {
        const ci = new Date(checkIn), co = new Date(checkOut);
        if (isNaN(ci) || isNaN(co) || co <= ci) return 0;
        const monthStart = new Date(year, month - 1, 1);
        const monthEnd = new Date(year, month, 1);
        const overlapStart = ci > monthStart ? ci : monthStart;
        const overlapEnd = co < monthEnd ? co : monthEnd;
        const nights = Math.ceil((overlapEnd - overlapStart) / (1000 * 60 * 60 * 24));
        return nights > 0 ? nights : 0;
      }

      function calcStayNights(checkIn, checkOut) {
        const ci = new Date(checkIn), co = new Date(checkOut);
        if (isNaN(ci) || isNaN(co)) return 0;
        const diff = Math.ceil((co - ci) / (1000 * 60 * 60 * 24));
        return diff > 0 ? diff : 0;
      }

      // 日本人判定: "日本", "Japan", "日本 / Japan", "日本/Japan" 等すべて日本人
      function isJapanese(nat) {
        const n = (nat || "日本").trim().toLowerCase();
        return n === "日本" || n === "japan" || n.includes("日本") || /^japan\b/i.test(n);
      }

      // プレースホルダ名判定（iCal同期で自動生成された仮名）
      function isPlaceholderName(name) {
        if (!name) return true;
        const n = name.trim().toLowerCase();
        return !n || n === "-" ||
          n.includes("airbnb") || n.includes("booking.com") ||
          n.includes("not available") || n.includes("closed") ||
          n.includes("予約") || n.includes("blocked");
      }

      // guestRegistrations 内の重複排除（同一CI+COで実名優先）
      const ciCoMap = new Map(); // key: "CI|CO" → best guest entry
      for (const g of rawGuests) {
        const ci = g.checkIn, co = g.checkOut;
        if (!ci || !co) continue;
        const key = `${ci}|${co}`;
        const existing = ciCoMap.get(key);
        if (!existing) {
          ciCoMap.set(key, g);
        } else {
          // 実名の方を優先（プレースホルダ名を除外）
          const existingIsPlaceholder = isPlaceholderName(existing.guestName);
          const newIsPlaceholder = isPlaceholderName(g.guestName);
          if (existingIsPlaceholder && !newIsPlaceholder) {
            ciCoMap.set(key, g); // 新しい方が実名 → 差し替え
          }
          // 両方実名 or 両方プレースホルダ → 既存を維持
        }
      }
      const guests = Array.from(ciCoMap.values());

      // guestRegistrations 集計
      // 人数計算: 名簿のguestCount（宿泊人数）を採用
      // 国籍別: 同行者情報があればそこから、なければ代表者の国籍×人数で計算
      for (const g of guests) {
        const ci = g.checkIn, co = g.checkOut;
        if (!ci || !co || co < periodStart || ci > periodEnd) continue;

        const guestCount = g.guestCount || 1;
        const nationality = (g.nationality || "日本").trim();
        const companions = g.guests || [];

        // 国籍別人数の計算
        let jpCount = 0, foreignCount = 0;
        const foreignByNat = {};

        if (companions.length > 0) {
          // 同行者情報あり → 代表者 + 同行者それぞれの国籍で集計
          const allPeople = [
            { nationality },
            ...companions.map((c) => ({ nationality: (c.nationality || "日本").trim() })),
          ];
          for (const p of allPeople) {
            if (isJapanese(p.nationality)) { jpCount++; }
            else { foreignCount++; foreignByNat[p.nationality] = (foreignByNat[p.nationality] || 0) + 1; }
          }
        } else {
          // 同行者情報なし → 代表者の国籍で全員カウント
          if (isJapanese(nationality)) { jpCount = guestCount; }
          else { foreignCount = guestCount; foreignByNat[nationality] = guestCount; }
        }

        const nights1 = calcNightsInMonth(ci, co, y1, m1);
        const nights2 = calcNightsInMonth(ci, co, y2, m2);

        if (nights1 > 0) {
          month1Data.totalNights += nights1;
          month1Data.japanese += jpCount;
          month1Data.foreign += foreignCount;
          for (const [nat, cnt] of Object.entries(foreignByNat)) {
            month1Data.byNationality[nat] = (month1Data.byNationality[nat] || 0) + cnt;
          }
        }
        if (nights2 > 0) {
          month2Data.totalNights += nights2;
          month2Data.japanese += jpCount;
          month2Data.foreign += foreignCount;
          for (const [nat, cnt] of Object.entries(foreignByNat)) {
            month2Data.byNationality[nat] = (month2Data.byNationality[nat] || 0) + cnt;
          }
        }

        if (nights1 > 0 || nights2 > 0) {
          details.push({
            id: g.id, source: "guestRegistrations", guestName: g.guestName || "-",
            nationality, checkIn: ci, checkOut: co,
            guestCount, nights1, nights2, totalNights: calcStayNights(ci, co),
          });
        }
      }

      // 重複チェック用: guestRegistrationsに存在するCI日のセット
      const guestCiSet = new Set(details.map((d) => d.checkIn));

      // 元データ（migrated_コレクション）から名簿にもbookingsにもないエントリを補完
      // iCal由来で氏名が空のためtransformでスキップされたデータを拾う
      const migratedCollections = ["migrated_民泊メイン_フォームの回答_1"];
      for (const colName of migratedCollections) {
        try {
          const mSnap = await db.collection(colName).get();
          for (const doc of mSnap.docs) {
            const d = doc.data();
            // CI/COを取得
            const ciRaw = d["チェックイン"] || d["チェックイン / Check-in"] || d["checkIn"];
            const coRaw = d["チェックアウト"] || d["チェックアウト / Check-out"] || d["checkOut"];
            if (!ciRaw || !coRaw) continue;
            // 日付をYYYY-MM-DD形式に（ローカルタイムゾーンで変換、UTC変換しない）
            const ciDate = new Date(ciRaw);
            const coDate = new Date(coRaw);
            if (isNaN(ciDate) || isNaN(coDate)) continue;
            const ciStr = `${ciDate.getFullYear()}-${String(ciDate.getMonth() + 1).padStart(2, "0")}-${String(ciDate.getDate()).padStart(2, "0")}`;
            const coStr = `${coDate.getFullYear()}-${String(coDate.getMonth() + 1).padStart(2, "0")}-${String(coDate.getDate()).padStart(2, "0")}`;
            if (coStr < periodStart || ciStr > periodEnd) continue;
            if (guestCiSet.has(ciStr)) continue; // 既にある

            const guestCount = 1; // 人数不明（後でoverridesで補完）
            const nights1 = calcNightsInMonth(ciStr, coStr, y1, m1);
            const nights2 = calcNightsInMonth(ciStr, coStr, y2, m2);
            if (nights1 > 0) { month1Data.totalNights += nights1; month1Data.japanese += guestCount; }
            if (nights2 > 0) { month2Data.totalNights += nights2; month2Data.japanese += guestCount; }

            if (nights1 > 0 || nights2 > 0) {
              details.push({
                id: doc.id, source: "migrated", guestName: "-（名簿未登録）",
                nationality: "不明", checkIn: ciStr, checkOut: coStr,
                guestCount, nights1, nights2, totalNights: calcStayNights(ciStr, coStr),
              });
              guestCiSet.add(ciStr);
            }
          }
        } catch (e) { /* コレクションが存在しない場合はスキップ */ }
      }

      details.sort((a, b) => (a.checkIn || "").localeCompare(b.checkIn || ""));

      // overrides を適用（レポート専用の手動補正値）
      let overrides = {};
      try {
        const reportDoc = await db.collection("reports").doc(periodId).get();
        if (reportDoc.exists) overrides = reportDoc.data().overrides || {};
      } catch (e) { /* 無視 */ }

      // overrides反映: 集計をやり直す
      if (Object.keys(overrides).length > 0) {
        // 集計リセット
        month1Data.totalNights = 0; month1Data.japanese = 0; month1Data.foreign = 0; month1Data.byNationality = {};
        month2Data.totalNights = 0; month2Data.japanese = 0; month2Data.foreign = 0; month2Data.byNationality = {};

        for (const d of details) {
          const ov = overrides[d.checkIn];
          if (ov) {
            // overrideで上書き
            if (ov.guestCount !== undefined) d.guestCount = ov.guestCount;
            if (ov.nationality !== undefined) d.nationality = ov.nationality;
            if (ov.guestName !== undefined) d.guestName = ov.guestName;
            d.overridden = true;
          }

          const gc = d.guestCount || 1;
          const nat = (d.nationality || "日本").trim();
          const jp = isJapanese(nat);

          const n1 = d.nights1 || 0;
          const n2 = d.nights2 || 0;
          if (n1 > 0) {
            month1Data.totalNights += n1;
            if (jp) month1Data.japanese += gc;
            else { month1Data.foreign += gc; month1Data.byNationality[nat] = (month1Data.byNationality[nat] || 0) + gc; }
          }
          if (n2 > 0) {
            month2Data.totalNights += n2;
            if (jp) month2Data.japanese += gc;
            else { month2Data.foreign += gc; month2Data.byNationality[nat] = (month2Data.byNationality[nat] || 0) + gc; }
          }
        }
      }

      return {
        period: { start: periodStart, end: periodEnd },
        month1: month1Data, month2: month2Data, details, overrides,
        totalNights: month1Data.totalNights + month2Data.totalNights,
        totalJapanese: month1Data.japanese + month2Data.japanese,
        totalForeign: month1Data.foreign + month2Data.foreign,
      };
    },

    // レポート専用の手動補正値を保存（宿泊者名簿には影響しない）
    async saveOverride(periodId, checkIn, data) {
      const ref = db.collection("reports").doc(periodId);
      const doc = await ref.get();
      const overrides = doc.exists ? (doc.data().overrides || {}) : {};
      overrides[checkIn] = { ...overrides[checkIn], ...data };
      await ref.set({ overrides, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    },

    async removeOverride(periodId, checkIn) {
      const ref = db.collection("reports").doc(periodId);
      const doc = await ref.get();
      if (!doc.exists) return;
      const overrides = doc.data().overrides || {};
      delete overrides[checkIn];
      await ref.update({ overrides, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    },

    async submit(periodId, memo) {
      await db.collection("reports").doc(periodId).set({
        periodId,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
        memo: memo || "",
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    },

    async unsubmit(periodId) {
      await db.collection("reports").doc(periodId).set({
        periodId,
        submittedAt: null,
        submittedBy: null,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    },
  },

  // チェックリスト API
  checklist: {
    async templates() {
      const snap = await db.collection("checklistTemplates").get();
      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    async saveTemplate(data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      if (data.id) {
        await db.collection("checklistTemplates").doc(data.id).update(data);
        return data;
      }
      const ref = await db.collection("checklistTemplates").add(data);
      return { id: ref.id, ...data };
    },

    async records(params = {}) {
      let query = db.collection("checklists");
      if (params.shiftId) query = query.where("shiftId", "==", params.shiftId);
      if (params.staffId) query = query.where("staffId", "==", params.staffId);
      const snap = await query.get();
      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    async update(id, data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("checklists").doc(id).update(data);
      return { id, ...data };
    },
  },
};
