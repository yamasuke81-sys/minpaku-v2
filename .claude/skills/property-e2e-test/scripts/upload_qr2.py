# -*- coding: utf-8 -*-
# GCS JSON API でアップ→firebaseStorageDownloadTokens を付与→timeeQrImageUrl 設定
import json, subprocess, urllib.request, urllib.parse, uuid, io

BUCKET = "minpaku-v2.firebasestorage.app"
FS = "https://firestore.googleapis.com/v1/projects/minpaku-v2/databases/(default)/documents"
TOKEN = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True, shell=True).strip()
H = {"Authorization": "Bearer " + TOKEN}

def call(url, method="GET", data=None, ctype=None):
    hdr = dict(H)
    if ctype: hdr["Content-Type"] = ctype
    req = urllib.request.Request(url, data=data, method=method, headers=hdr)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or "{}")

for pid, fname, label in [
    ("ncUKeD4yQo0kfAoznITu", "ujina_qr.png", "宇品"),
    ("ZXW6wdpnBFk1azQ87KXQ", "wakakusa_qr.png", "若草"),
]:
    obj = "timee-qr/%s.png" % pid
    objq = urllib.parse.quote(obj, safe="")
    data = io.open(fname, "rb").read()
    up = call("https://storage.googleapis.com/upload/storage/v1/b/%s/o?uploadType=media&name=%s" % (BUCKET, objq),
              "POST", data, "image/png")
    print(label, "アップロード OK:", up.get("name"), up.get("size"), "bytes")
    tok = str(uuid.uuid4())
    call("https://storage.googleapis.com/storage/v1/b/%s/o/%s" % (BUCKET, objq),
         "PATCH", json.dumps({"metadata": {"firebaseStorageDownloadTokens": tok}, "contentType": "image/png"}).encode(),
         "application/json")
    dl_url = "https://firebasestorage.googleapis.com/v0/b/%s/o/%s?alt=media&token=%s" % (BUCKET, objq, tok)
    with urllib.request.urlopen(dl_url) as r:  # トークンURLの実疎通(無認証)
        ok = (r.status == 200 and len(r.read()) == len(data))
    print(label, "ダウンロードURL疎通:", "OK" if ok else "NG")
    fields = {"timeeQrImageUrl": {"stringValue": dl_url},
              "timeeQrUpdatedAt": {"timestampValue": "2026-08-11T14:10:00+09:00"}}
    call("%s/properties/%s?updateMask.fieldPaths=timeeQrImageUrl&updateMask.fieldPaths=timeeQrUpdatedAt" % (FS, pid),
         "PATCH", json.dumps({"fields": fields}).encode(), "application/json")
    print(label, "timeeQrImageUrl 設定 OK")
