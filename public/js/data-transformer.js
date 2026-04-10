/**
 * データ変換モジュール
 * インポート済みの生データ（migrated_*）を新アプリの正式コレクションに変換
 */
const DataTransformer = {
  /**
   * 全変換を実行
   */
  async transformAll() {
    const results = {};
    const ts = firebase.firestore.FieldValue.serverTimestamp();

    // 1. スタッフ変換
    results.staff = await this.transformStaff(ts);

    // 2. 予約変換
    results.bookings = await this.transformBookings(ts);

    // 3. 物件（予約データから物件名を抽出して自動生成）
    results.properties = await this.createPropertiesFromBookings(ts);

    // 4. シフト（募集データから清掃スケジュールを生成）
    results.shifts = await this.transformShifts(ts);

    // 5. ランドリー
    results.laundry = await this.transformLaundry(ts);

    // 6. 報酬 → 請求書データ
    results.rewards = await this.transformRewards(ts);

    // 7. チェックリストテンプレート
    results.checklistTemplates = await this.transformChecklistTemplates(ts);

    // 8. 宿泊者名簿（フォームの回答 1 → guestRegistrations/）
    results.guestRegistrations = await this.transformGuestRegistrations(ts);

    return results;
  },

  /**
   * スタッフ: 清掃スタッフ → staff/
   */
  async transformStaff(ts) {
    const snap = await db.collection("清掃スタッフ").get();
    if (snap.empty) return 0;

    let count = 0;
    const batch = db.batch();

    for (const doc of snap.docs) {
      const d = doc.data();
      const name = (d["名前"] || d["name"] || "").trim();
      if (!name) continue;

      // 既に同名スタッフが存在するか確認
      const existing = await db.collection("staff").where("name", "==", name).limit(1).get();
      if (!existing.empty) continue;

      const ref = db.collection("staff").doc();
      batch.set(ref, {
        name,
        email: (d["メール"] || d["email"] || "").trim(),
        phone: (d["電話"] || d["phone"] || "").trim(),
        skills: [],
        availableDays: [],
        ratePerJob: 0,
        transportationFee: 0,
        bankName: (d["金融機関名"] || d["bankName"] || "").trim(),
        branchName: (d["支店名"] || d["branchName"] || "").trim(),
        accountType: (d["口座種類"] || d["accountType"] || "普通").trim(),
        accountNumber: (d["口座番号"] || d["accountNumber"] || "").toString().trim(),
        accountHolder: (d["口座名義"] || d["accountHolder"] || "").trim(),
        memo: (d["住所"] || d["address"] || "").trim(),
        active: (d["有効"] || d["active"] || "Y") !== "N",
        displayOrder: count,
        createdAt: ts,
        updatedAt: ts,
      });
      count++;
    }

    if (count > 0) await batch.commit();
    return count;
  },

  /**
   * 予約: フォームの回答 1 → bookings/
   */
  async transformBookings(ts) {
    const collections = ["フォームの回答 1", "migrated_民泊メイン_フォームの回答_1"];
    let count = 0;

    for (const colName of collections) {
      const snap = await db.collection(colName).get();
      if (snap.empty) continue;

      for (const doc of snap.docs) {
        const d = doc.data();
        const checkIn = this.findField(d, ["チェックイン", "Check-in", "checkIn"]);
        const checkOut = this.findField(d, ["チェックアウト", "Check-out", "checkOut"]);
        if (!checkIn && !checkOut) continue;

        await db.collection("bookings").add({
          propertyId: "",
          beds24BookingId: "",
          guestName: (this.findField(d, ["氏名", "Full Name", "お名前", "guestName"]) || "").trim(),
          guestCount: this.extractNumber(this.findField(d, ["宿泊人数", "人数", "guestCount"])),
          checkIn: this.parseDate(checkIn),
          checkOut: this.parseDate(checkOut),
          source: "migrated",
          status: "completed",
          bbq: this.parseBool(d["BBQ"]),
          parking: this.parseBool(d["駐車場"]),
          notes: (d["メモ"] || d["notes"] || "").trim(),
          cleaningStaff: (d["清掃担当"] || "").trim(),
          nationality: (d["国籍"] || "").trim(),
          createdAt: ts,
        });
        count++;
      }
    }

    return count;
  },

  /**
   * 予約データから物件を自動抽出して properties/ に登録
   */
  async createPropertiesFromBookings(ts) {
    // 既存の物件がなければデフォルト物件を1つ作成
    const existingProps = await db.collection("properties").get();
    if (!existingProps.empty) return 0;

    await db.collection("properties").add({
      name: "メイン物件",
      type: "minpaku",
      beds24PropertyId: "",
      address: "",
      area: "",
      capacity: 0,
      cleaningDuration: 90,
      cleaningFee: 0,
      requiredSkills: [],
      monthlyFixedCost: 0,
      purchasePrice: 0,
      purchaseDate: null,
      notes: "自動生成（移行データから）",
      active: true,
      createdAt: ts,
      updatedAt: ts,
    });
    return 1;
  },

  /**
   * 募集 → shifts/（清掃スケジュール）
   */
  async transformShifts(ts) {
    const snap = await db.collection("募集").get();
    if (snap.empty) return 0;

    // 物件IDを取得
    const propSnap = await db.collection("properties").limit(1).get();
    const propertyId = propSnap.empty ? "" : propSnap.docs[0].id;

    let count = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      const coDate = d["チェックアウト日"] || d["checkOutDate"];
      if (!coDate) continue;

      const status = (d["ステータス"] || d["status"] || "").trim();
      const selectedStaff = (d["選定スタッフ"] || d["selectedStaff"] || "").trim();

      await db.collection("shifts").add({
        date: this.parseDate(coDate),
        propertyId,
        bookingId: "",
        staffId: null,
        staffName: selectedStaff || null,
        startTime: null,
        endTime: null,
        status: selectedStaff ? "completed" : "unassigned",
        assignMethod: "manual",
        checklistId: null,
        _originalStatus: status,
        createdAt: ts,
      });
      count++;
    }
    return count;
  },

  /**
   * コインランドリー関連の報酬 → laundry/
   */
  async transformLaundry(ts) {
    const snap = await db.collection("スタッフ報酬").get();
    if (snap.empty) return 0;

    let count = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      const jobType = (d["仕事内容名"] || d["jobType"] || "").trim();
      if (!jobType.includes("コインランドリー") && !jobType.includes("ランドリー")) continue;

      await db.collection("laundry").add({
        date: this.parseDate(d["日付"] || d["date"]) || new Date(),
        staffId: "",
        staffName: (d["スタッフ名"] || d["staffName"] || "").trim(),
        propertyId: "",
        amount: Number(d["報酬額"] || d["amount"]) || 0,
        sheets: 0,
        memo: (d["備考"] || d["memo"] || "").trim(),
        createdAt: ts,
      });
      count++;
    }
    return count;
  },

  /**
   * スタッフ報酬 → rewards/（集計用に保持）
   */
  async transformRewards(ts) {
    const snap = await db.collection("スタッフ報酬").get();
    if (snap.empty) return 0;

    let count = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d["スタッフ名"] && !d["staffName"]) continue;

      await db.collection("rewards").add({
        staffName: (d["スタッフ名"] || d["staffName"] || "").trim(),
        jobType: (d["仕事内容名"] || d["jobType"] || "").trim(),
        amount: Number(d["報酬額"] || d["amount"]) || 0,
        memo: (d["備考"] || d["memo"] || "").trim(),
        createdAt: ts,
      });
      count++;
    }
    return count;
  },

  /**
   * チェックリストマスタ → checklistTemplates/
   */
  async transformChecklistTemplates(ts) {
    const snap = await db.collection("チェックリストマスタ").get();
    if (snap.empty) return 0;

    // 物件IDを取得
    const propSnap = await db.collection("properties").limit(1).get();
    const propertyId = propSnap.empty ? "" : propSnap.docs[0].id;

    const items = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      const name = d["項目名"] || d["チェック項目"] || d["name"] || "";
      if (!name) continue;
      items.push({
        name: String(name).trim(),
        required: true,
        photoRequired: false,
      });
    }

    if (items.length === 0) return 0;

    await db.collection("checklistTemplates").add({
      propertyId,
      items,
      updatedAt: ts,
    });

    return items.length;
  },

  /**
   * フォームの回答 1 → guestRegistrations/（宿泊者名簿）
   * Googleフォームのカラム名から自動マッピング
   */
  async transformGuestRegistrations(ts) {
    const collections = ["フォームの回答 1", "migrated_民泊メイン_フォームの回答_1"];
    let count = 0;

    for (const colName of collections) {
      const snap = await db.collection(colName).get();
      if (snap.empty) continue;

      for (const doc of snap.docs) {
        const d = doc.data();
        // チェックイン日がないデータはスキップ（部分一致でヘッダー対応）
        const checkIn = this.findField(d, ["チェックイン", "Check-in", "checkIn"]);
        if (!checkIn) continue;

        const checkOut = this.findField(d, ["チェックアウト", "Check-out", "checkOut"]);

        // 代表者氏名（部分一致で対応）
        const guestName = (
          this.findField(d, ["氏名", "Full Name", "お名前", "guestName"]) || ""
        ).trim();
        if (!guestName) continue;

        const checkInStr = this.formatDateStr(checkIn);

        // 宿泊人数の抽出（部分一致: 「宿泊人数 / Number of Guests\n※ ...」等に対応）
        const guestCountRaw = this.findField(d, ["宿泊人数", "人数", "guestCount", "iCal宿泊人数"]);
        const guestCount = this.extractNumber(guestCountRaw);
        // 乳幼児: 「3才以下」は宿泊人数フィールド名にも含まれるため除外し「乳幼児」で検索
        const infantsRaw = this.findField(d, ["乳幼児", "guestCountInfants", "infants"]);
        const guestCountInfants = this.extractNumber(infantsRaw);

        // 電話番号（複数カラムに対応）
        const phone = this.findField(d, ["電話", "TEL", "電話番号", "phone"]);
        const email = this.findField(d, ["メール", "mail", "email", "メールアドレス"]);
        const nationality = this.findField(d, ["国籍", "Nationality", "nationality"]) || "日本";
        const address = this.findField(d, ["住所", "address", "Address"]);
        const purpose = this.findField(d, ["旅の目的", "目的", "purpose"]);
        const passport = this.findField(d, ["旅券番号", "passport number", "passportNumber"]);

        // 予約サイト
        const bookingSite = (
          d["どこでこのホテルを予約しましたか？"] || d["bookingSite"] || ""
        ).trim();

        // BBQ・駐車場
        const bbq = this.findField(d, ["バーベキュー", "BBQ", "bbq"]);
        const parking = this.findField(d, ["有料駐車場", "parking", "駐車場"]);
        const memo = this.findField(d, ["メモ", "備考", "notes", "memo"]);

        // 同行者の抽出（フォームには「氏名2」「氏名3」等のカラムがある場合）
        const guests = this.extractCompanions(d);

        const newData = {
          guestName,
          nationality,
          address: address || "",
          phone: phone || "",
          email: email || "",
          passportNumber: passport || "",
          purpose: purpose || "",
          checkIn: checkInStr || "",
          checkOut: this.formatDateStr(checkOut) || "",
          guestCount: guestCount || 0,
          guestCountInfants: guestCountInfants || 0,
          bookingSite,
          bbq: bbq || "",
          parking: parking || "",
          memo: memo || "",
          guests,
          propertyId: "",
          source: "google_form",
          formResponseRow: 0,
        };

        // 同一CIの既存エントリを検索→あればマージ、なければ新規作成
        // API.guests.create() のマージロジックを利用
        await API.guests.create(newData);
        count++;
      }
    }
    return count;
  },

  /**
   * guestRegistrations の guestCount を元データから再取り込み
   * 移行時にフィールド名の不一致で guestCount=0 になった問題を修正
   */
  async fixGuestCounts(ts) {
    const collections = ["フォームの回答 1", "migrated_民泊メイン_フォームの回答_1"];
    // 元データのCI+名前→人数マップを構築
    const countMap = new Map(); // key: "checkIn|guestName" → {guestCount, guestCountInfants}
    for (const colName of collections) {
      const snap = await db.collection(colName).get();
      if (snap.empty) continue;
      for (const doc of snap.docs) {
        const d = doc.data();
        const checkIn = d["チェックイン"] || d["チェックイン / Check-in"] || d["checkIn"];
        if (!checkIn) continue;
        const guestName = (
          d["氏名"] || d["氏名 / Full Name"] || d["お名前"] || d["guestName"] || ""
        ).trim();
        if (!guestName) continue;

        const checkInStr = this.formatDateStr(checkIn);
        // 宿泊人数（部分一致で検索）
        const guestCountRaw = this.findField(d, ["宿泊人数", "人数", "guestCount", "iCal宿泊人数"]);
        const guestCount = this.extractNumber(guestCountRaw);
        // 乳幼児: 「3才以下」は宿泊人数フィールド名にも含まれるため除外し「乳幼児」で検索
        const infantsRaw = this.findField(d, ["乳幼児", "guestCountInfants", "infants"]);
        const guestCountInfants = this.extractNumber(infantsRaw);

        if (guestCount > 0 || guestCountInfants > 0) {
          countMap.set(`${checkInStr}|${guestName}`, { guestCount, guestCountInfants });
        }
      }
    }

    // guestRegistrations を元データで上書き修正
    const guestSnap = await db.collection("guestRegistrations").get();
    let fixed = 0;
    for (const doc of guestSnap.docs) {
      const g = doc.data();
      const key = `${g.checkIn || ""}|${g.guestName || ""}`;
      const match = countMap.get(key);
      if (!match) continue;

      // 値が異なる場合のみ更新
      const needsUpdate =
        (g.guestCount || 0) !== match.guestCount ||
        (g.guestCountInfants || 0) !== match.guestCountInfants;

      if (needsUpdate) {
        await db.collection("guestRegistrations").doc(doc.id).update({
          guestCount: match.guestCount,
          guestCountInfants: match.guestCountInfants,
          updatedAt: ts,
        });
        fixed++;
      }
    }
    return fixed;
  },

  // ===== ユーティリティ =====

  parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return val;
    // Firestore Timestamp
    if (val.toDate) return val.toDate();
    // ISO文字列 or 日本語日付
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  },

  parseBool(val) {
    if (!val) return false;
    const s = String(val).trim().toLowerCase();
    return s.includes("あり") || s === "true" || s === "yes" || s === "1";
  },

  /**
   * 日付をYYYY-MM-DD文字列に変換
   */
  formatDateStr(val) {
    if (!val) return "";
    const d = this.parseDate(val);
    if (!d) return String(val).trim();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  },

  /**
   * 文字列から数値を抽出（「4人」→4、「大人3名」→3）
   */
  extractNumber(val) {
    if (!val) return 0;
    if (typeof val === "number") return val;
    const m = String(val).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  },

  /**
   * 複数のキー名でフィールドを検索
   */
  findField(d, keys) {
    for (const k of keys) {
      // 完全一致
      if (d[k] !== undefined && d[k] !== "") return String(d[k]).trim();
      // 部分一致
      for (const dk of Object.keys(d)) {
        if (dk.includes(k) && d[dk] !== undefined && d[dk] !== "") {
          return String(d[dk]).trim();
        }
      }
    }
    return "";
  },

  /**
   * 同行者データを抽出（「氏名2」「国籍2」等のカラムから）
   */
  extractCompanions(d) {
    const companions = [];
    // 番号付きカラムを検索（氏名2, 氏名3, ... / Full Name 2, etc.）
    for (let i = 2; i <= 10; i++) {
      let name = "";
      for (const k of Object.keys(d)) {
        if ((k.includes("氏名") || k.includes("名前") || k.toLowerCase().includes("name")) &&
            (k.includes(String(i)) || k.endsWith(`_${i}`))) {
          name = String(d[k] || "").trim();
          break;
        }
      }
      if (!name) continue;

      let nat = "", age = "", pp = "";
      for (const k of Object.keys(d)) {
        if (k.includes(String(i)) || k.endsWith(`_${i}`)) {
          if ((k.includes("国籍") || k.toLowerCase().includes("nationality")) && !nat) {
            nat = String(d[k] || "").trim();
          }
          if ((k.includes("年齢") || k.toLowerCase().includes("age")) && !age) {
            age = String(d[k] || "").trim();
          }
          if ((k.includes("旅券") || k.toLowerCase().includes("passport")) && !pp) {
            pp = String(d[k] || "").trim();
          }
        }
      }
      companions.push({
        name,
        age: age || "",
        nationality: nat || "日本",
        address: "",
        passportNumber: pp || "",
      });
    }
    return companions;
  },
};
