# HADES

Bu klasor, ana projeye dokunulmadan GitHub icin hazirlanmis temiz kopyadir.

## Bu kopyada neler var

- Uygulamanin kaynak kodu, arayuz dosyalari, Electron katmani ve testleri
- `package.json`, `package-lock.json`, `start.bat` ve bos `hades-schedule-db.json`
- Guvenli paylasim icin guncellenmis `.env.example` ve `.gitignore`

## Guvenlik icin cikarilanlar

- Gercek `.env` dosyasi
- `spotify-token.json` oturum belirtecleri
- `UserData/` tarayici oturum ve profil verileri
- `chromium/`, `node_modules/`, `.venv-voice/` gibi agir veya yeniden uretilebilir runtime klasorleri
- Gecici ekran goruntuleri ve cache dosyalari

## Kurulum

1. `.env.example` dosyasini `.env` olarak kopyalayin.
2. Gerekli anahtarlari ve servis ayarlarini `.env` icine yazin.
3. Gerekirse Google Speech icin `GOOGLE_APPLICATION_CREDENTIALS` degiskenine servis hesap JSON yolunu verin.
4. Paketleri kurun:

```powershell
npm install
```

5. Masaustu surumunu baslatin:

```powershell
npm start
```

Alternatif olarak Windows icin `start.bat` calistirilabilir.

## Test ve paketleme

```powershell
npm test
npm run dist:win
```

## GitHub'a yukleme

```powershell
git init
git add .
git commit -m "Initial sanitized HADES release"
git branch -M main
git remote add origin <REPO_URL>
git push -u origin main
```

## Not

Bu temiz kopyada API entegrasyon kodlari korunmustur; yalnizca gizli anahtarlar, tokenlar ve yerel oturum verileri cikartilmistir.
