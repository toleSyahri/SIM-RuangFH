/* ====================================================================
   SIM-RUANG FH UNESA - app.js
   "OTAK + TANGAN-KAKI" - Semua logic, validasi, dan komunikasi ke
   backend (Code.gs) lewat SCRIPT_URL.
   Ubah file ini kalau mau tambah/ubah FITUR/PERILAKU.
   Perubahan di sini TIDAK memengaruhi tampilan (lihat style.css) atau
   struktur halaman (lihat index.html).
   ==================================================================== */

/* ================================================================
       KONFIGURASI
       ================================================================ */
    const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz1gxUfiS01WKtFETlcq1ecfBZrNU99t-i-R8WhMYTnFcLzvCoA3l7bvFrgwoIfFFDE9Q/exec";
    const JSONP_TIMEOUT_MS = 15000;

    let currentUser = null;
    let dataRuanganGlobal = [];
    let dataPinjamanGlobal = [];

    /* ================================================================
       HELPER: KEAMANAN & UTILITAS
       ================================================================ */

    // Cegah XSS: escape semua data yang berasal dari input pengguna
    // sebelum disisipkan ke dalam innerHTML.
    function escapeHtml(str) {
        if (str === null || str === undefined) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function showError(elId, message) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.textContent = message;
        el.classList.remove("hidden");
    }

    function clearError(elId) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.classList.add("hidden");
        el.textContent = "";
    }

    function setButtonLoading(btnId, isLoading, loadingText, defaultText) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.disabled = isLoading;
        btn.textContent = isLoading ? loadingText : defaultText;
    }

    // Normalisasi nomor HP Indonesia ke format 62xxxx untuk link WhatsApp.
    function normalizeWaNumber(hp) {
        let raw = (hp && hp !== "-") ? hp.toString() : "";
        let clean = raw.replace(/[^0-9]/g, "");
        if (clean.startsWith("0")) {
            clean = "62" + clean.substring(1);
        } else if (clean.startsWith("8")) {
            clean = "62" + clean;
        }
        return clean;
    }

    function buildWaLink(hp, message) {
        const clean = normalizeWaNumber(hp);
        const encoded = encodeURIComponent(message);
        return clean ? `https://api.whatsapp.com/send?phone=${clean}&text=${encoded}` : `https://wa.me/`;
    }

    /* ================================================================
       HELPER: KOMUNIKASI DENGAN BACKEND (JSONP + TIMEOUT)
       ================================================================ */
    // CATATAN PERBAIKAN BUG: sebelumnya fungsi ini memakai nama callback
    // TETAP (mis. "cb_askAssistant") yang dibungkus ulang setiap kali
    // dipanggil, tanpa pernah dikembalikan ke fungsi aslinya. Akibatnya,
    // untuk aksi yang dipanggil berkali-kali (chat CS, refresh tabel,
    // update status, dsb.) -- panggilan ke-2 dst bisa "menembak" ke
    // pembungkus panggilan sebelumnya yang sudah selesai, sehingga
    // respons dari server tidak pernah sampai ke UI (macet di loading).
    // Perbaikannya: setiap panggilan JSONP dapat nama callback UNIK,
    // dan `handlerFn` dikirim sebagai referensi fungsi langsung -- tidak
    // lagi lewat nama string global yang bisa saling tabrakan.
    let jsonpCallCounter = 0;

    function executeJSONP(url, handlerFn, onError) {
        const uniqueCallbackName = '_jsonpCb_' + (++jsonpCallCounter) + '_' + Date.now();
        const scriptId = 'jsonp-' + uniqueCallbackName;

        let settled = false;

        const timeoutId = setTimeout(function () {
            if (settled) return;
            settled = true;
            cleanup();
            if (typeof onError === "function") {
                onError("Server tidak merespons. Periksa koneksi internet Anda dan coba lagi.");
            }
        }, JSONP_TIMEOUT_MS);

        function cleanup() {
            clearTimeout(timeoutId);
            const s = document.getElementById(scriptId);
            if (s) s.remove();
            delete window[uniqueCallbackName];
        }

        window[uniqueCallbackName] = function (response) {
            if (settled) return;
            settled = true;
            cleanup();
            handlerFn(response);
        };

        const script = document.createElement('script');
        script.id = scriptId;
        script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + uniqueCallbackName;
        script.onerror = function () {
            if (settled) return;
            settled = true;
            cleanup();
            if (typeof onError === "function") {
                onError("Gagal terhubung ke server. Pastikan SCRIPT_URL sudah benar dan backend aktif.");
            } else {
                alert('Gagal terhubung ke Google Sheets API! Pastikan SCRIPT_URL diisi dengan benar.');
            }
        };
        document.body.appendChild(script);
    }

    /* ================================================================
       AUTENTIKASI: LOGIN / REGISTRASI / LOGOUT
       ================================================================ */
    function switchAuthTab(tab) {
        clearError('login-error');
        clearError('register-error');
        const isLogin = tab === 'login';
        document.getElementById("btn-tab-login").classList.toggle("active", isLogin);
        document.getElementById("btn-tab-register").classList.toggle("active", !isLogin);
        document.getElementById("form-login-container").classList.toggle("hidden", !isLogin);
        document.getElementById("form-register-container").classList.toggle("hidden", isLogin);
    }

    // Catatan keamanan: proses login TIDAK LAGI menyimpan kredensial admin
    // di client-side. Semua autentikasi (user maupun admin) divalidasi oleh
    // backend (Apps Script) lewat action=loginUser, yang mengembalikan
    // field "role" pada objek user. Pastikan backend memvalidasi password
    // secara aman (hash, bukan plaintext di Sheet) dan menandai baris admin
    // secara terpisah -- lihat catatan di akhir jawaban.
    function prosesLogin() {
        clearError('login-error');
        const user = document.getElementById("login-username").value.trim();
        const pass = document.getElementById("login-password").value.trim();

        if (!user || !pass) {
            showError('login-error', 'Username dan password wajib diisi.');
            return;
        }

        setButtonLoading('btn-login-submit', true, 'Memproses...', 'Login ke Sistem');
        const url = `${SCRIPT_URL}?action=loginUser&username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
        executeJSONP(url, cb_login, function (msg) {
            setButtonLoading('btn-login-submit', false, 'Memproses...', 'Login ke Sistem');
            showError('login-error', msg);
        });
    }

    function cb_login(response) {
        setButtonLoading('btn-login-submit', false, 'Memproses...', 'Login ke Sistem');
        if (response.status === "success") {
            currentUser = {
                nama: response.user.nama,
                nim: response.user.nim,
                hp: response.user.hp,
                email: response.user.email,
                role: response.user.role === "admin" ? "admin" : "pengguna"
            };
            masukDashboard();
        } else {
            showError('login-error', response.message || "Login gagal. Periksa kembali Username/Password Anda.");
        }
    }

    function prosesRegistrasi() {
        clearError('register-error');
        const nama = document.getElementById("reg-nama").value.trim();
        const prodi = document.getElementById("reg-prodi").value.trim();
        const nim = document.getElementById("reg-nim").value.trim();
        const hp = document.getElementById("reg-wa").value.trim();
        const email = document.getElementById("reg-email").value.trim();
        const username = document.getElementById("reg-username").value.trim();
        const pass = document.getElementById("reg-password").value;

        if (pass.length < 6) {
            showError('register-error', 'Password minimal 6 karakter.');
            return;
        }

        setButtonLoading('btn-register-submit', true, 'Mendaftarkan...', 'Daftarkan Akun Saya');
        const url = `${SCRIPT_URL}?action=registerUser&nama=${encodeURIComponent(nama)}&prodi=${encodeURIComponent(prodi)}&nim=${encodeURIComponent(nim)}&hp=${encodeURIComponent(hp)}&email=${encodeURIComponent(email)}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(pass)}`;
        executeJSONP(url, cb_register, function (msg) {
            setButtonLoading('btn-register-submit', false, 'Mendaftarkan...', 'Daftarkan Akun Saya');
            showError('register-error', msg);
        });
    }

    function cb_register(response) {
        setButtonLoading('btn-register-submit', false, 'Mendaftarkan...', 'Daftarkan Akun Saya');
        if (response.status === "success") {
            switchAuthTab('login');
            clearError('login-error');
            alert(response.message);
            if (response.waUrl) window.open(response.waUrl, '_blank');
        } else {
            showError('register-error', response.message || 'Pendaftaran gagal. Silakan coba lagi.');
        }
    }

    function masukDashboard() {
        document.getElementById("section-auth").classList.add("hidden");
        document.getElementById("section-dashboard").classList.remove("hidden");
        document.getElementById("user-display").textContent = currentUser.nama;
        document.getElementById("role-display").textContent = currentUser.role.toUpperCase();

        const isAdmin = currentUser.role === "admin";
        document.getElementById("section-admin-vip").classList.toggle("hidden", !isAdmin);
        document.getElementById("th-aksi-pinjaman").classList.toggle("hidden", !isAdmin);
        document.getElementById("th-aksi-ruangan").classList.toggle("hidden", !isAdmin);
        document.getElementById("dash-tab-btn-vip").classList.toggle("hidden", !isAdmin);
        document.getElementById("dash-tab-btn-laporan").classList.toggle("hidden", !isAdmin);
        document.getElementById("btn-toggle-kelola-ruang").classList.toggle("hidden", !isAdmin);
        // section-admin-kelola-ruang tetap tersembunyi secara default (baik admin
        // maupun bukan) -- admin membukanya sendiri lewat tombol "+ Tambah/Kelola
        // Ruangan" supaya tab Data Ruangan tidak langsung penuh dengan form.
        document.getElementById("section-admin-kelola-ruang").classList.add("hidden");

        switchDashTab('ajukan');
        loadDataRuangan();
        loadDataPinjaman();
    }

    /* ================================================================
       NAVIGASI TAB DASHBOARD
       ================================================================ */
    function switchDashTab(tabId) {
        document.querySelectorAll('.dash-tab-panel').forEach(function (p) { p.classList.add('hidden'); });
        document.querySelectorAll('.dash-tab-btn').forEach(function (b) { b.classList.remove('active'); });

        const panel = document.getElementById('dash-tab-' + tabId);
        if (panel) panel.classList.remove('hidden');

        const btn = document.querySelector('.dash-tab-btn[data-tab="' + tabId + '"]');
        if (btn) btn.classList.add('active');
    }

    function toggleKelolaRuangPanel() {
        document.getElementById("section-admin-kelola-ruang").classList.toggle("hidden");
    }

    function logout() {
        currentUser = null;
        dataRuanganGlobal = [];
        dataPinjamanGlobal = [];
        document.getElementById("section-auth").classList.remove("hidden");
        document.getElementById("section-dashboard").classList.add("hidden");
        document.getElementById("login-username").value = "";
        document.getElementById("login-password").value = "";
    }

    /* ================================================================
       DATA RUANGAN
       ================================================================ */
    function loadDataRuangan() {
        document.getElementById("loading-ruangan").classList.remove("hidden");
        clearError('error-ruangan');
        executeJSONP(`${SCRIPT_URL}?action=getRooms`, cb_getRooms, function (msg) {
            document.getElementById("loading-ruangan").classList.add("hidden");
            showError('error-ruangan', msg);
        });
    }

    function cb_getRooms(response) {
        document.getElementById("loading-ruangan").classList.add("hidden");
        if (response.status === "success") {
            dataRuanganGlobal = response.data;
            renderTabelRuangan(response.data);
            populateDropdownRuang(response.data);
        } else {
            showError('error-ruangan', response.message || 'Gagal memuat data ruangan.');
        }
    }

    function renderTabelRuangan(rooms) {
        const tbody = document.getElementById("tabel-ruangan");
        const isAdmin = currentUser && currentUser.role === "admin";
        const colspan = isAdmin ? 10 : 9;

        if (!rooms || rooms.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${colspan}">Belum ada data ruangan.</td></tr>`;
            return;
        }
        tbody.innerHTML = rooms.map(r => `
            <tr>
                <td>Lantai ${escapeHtml(r.lantai)}</td>
                <td><strong>${escapeHtml(r.code)}</strong></td>
                <td>${escapeHtml(r.kursi)} Kursi</td>
                <td>${escapeHtml(r.tvSmart)}</td>
                <td>${escapeHtml(r.ac)}</td>
                <td>${escapeHtml(r.stopKontak)}</td>
                <td>${escapeHtml(r.papanTulis)}</td>
                <td>${escapeHtml(r.waktuLayanan)}</td>
                <td>${escapeHtml(r.program)}</td>
                ${isAdmin ? aksiRuanganHtml(r) : ""}
            </tr>
        `).join("");
    }

    function aksiRuanganHtml(r) {
        return `
            <td>
                <button onclick="editRuang(${r.rowIndex})" class="btn-warning btn-sm" type="button">Edit</button>
                <button onclick="hapusRuang(${r.rowIndex})" class="btn-danger btn-sm" type="button">Hapus</button>
            </td>
        `;
    }

    function populateDropdownRuang(rooms) {
        const options = ['<option value="">-- Pilih Ruangan --</option>']
            .concat(rooms.map(r => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.code)} (Lantai ${escapeHtml(r.lantai)} - Kapasitas: ${escapeHtml(r.kursi)})</option>`))
            .join("");
        const selectPinjam = document.getElementById("pinjam-ruang");
        const selectVip = document.getElementById("vip-ruang");
        if (selectPinjam) selectPinjam.innerHTML = options;
        if (selectVip) selectVip.innerHTML = options;

        const selectLaporan = document.getElementById("laporan-ruang");
        if (selectLaporan) {
            const optionsLaporan = ['<option value="">-- Semua Ruangan --</option>']
                .concat(rooms.map(r => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.code)}</option>`))
                .join("");
            selectLaporan.innerHTML = optionsLaporan;
        }
    }

    function filterTabelRuangan() {
        const q = document.getElementById("cari-ruangan").value.trim().toLowerCase();
        if (!q) {
            renderTabelRuangan(dataRuanganGlobal);
            return;
        }
        const filtered = dataRuanganGlobal.filter(r =>
            String(r.code).toLowerCase().includes(q) ||
            String(r.lantai).toLowerCase().includes(q) ||
            String(r.program).toLowerCase().includes(q)
        );
        renderTabelRuangan(filtered);
    }

    /* ================================================================
       AKSI ADMIN: KELOLA DATA RUANGAN (TAMBAH / EDIT / HAPUS)
       ================================================================ */
    function editRuang(rowIndex) {
        const r = dataRuanganGlobal.find(x => x.rowIndex === rowIndex);
        if (!r) return;

        // Buka panel kelola-ruang kalau sedang tertutup, supaya form yang
        // diisi ini terlihat oleh admin.
        document.getElementById("section-admin-kelola-ruang").classList.remove("hidden");

        document.getElementById("ruang-row-index").value = r.rowIndex;
        document.getElementById("ruang-lantai").value = r.lantai;
        document.getElementById("ruang-code").value = r.code;
        document.getElementById("ruang-kursi").value = r.kursi;
        document.getElementById("ruang-tv").value = r.tvSmart === "Ada" ? "Ada" : "Tidak Ada";
        document.getElementById("ruang-ac").value = r.ac === "Ada" ? "Ada" : "Tidak Ada";
        document.getElementById("ruang-stopkontak").value = r.stopKontak === "Ada" ? "Ada" : "Tidak Ada";
        document.getElementById("ruang-papantulis").value = r.papanTulis === "Ada" ? "Ada" : "Tidak Ada";
        document.getElementById("ruang-waktu").value = r.waktuLayanan;
        document.getElementById("ruang-program").value = r.program;

        document.getElementById("btn-ruang-submit").textContent = "Update Data Ruangan";
        document.getElementById("btn-ruang-batal").classList.remove("hidden");
        clearError('ruang-error');
        document.getElementById("section-admin-kelola-ruang").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function batalEditRuang() {
        document.getElementById("ruang-row-index").value = "";
        document.querySelector("#section-admin-kelola-ruang form").reset();
        document.getElementById("btn-ruang-submit").textContent = "Simpan Data Ruangan";
        document.getElementById("btn-ruang-batal").classList.add("hidden");
        clearError('ruang-error');
    }

    function simpanRuang() {
        clearError('ruang-error');
        const rowIndex = document.getElementById("ruang-row-index").value;
        const lantai = document.getElementById("ruang-lantai").value.trim();
        const code = document.getElementById("ruang-code").value.trim();
        const kursi = document.getElementById("ruang-kursi").value.trim();
        const tvSmart = document.getElementById("ruang-tv").value;
        const ac = document.getElementById("ruang-ac").value;
        const stopKontak = document.getElementById("ruang-stopkontak").value;
        const papanTulis = document.getElementById("ruang-papantulis").value;
        const waktuLayanan = document.getElementById("ruang-waktu").value.trim();
        const program = document.getElementById("ruang-program").value.trim();

        if (!lantai || !code || !kursi || !waktuLayanan || !program) {
            showError('ruang-error', 'Semua field wajib diisi.');
            return;
        }

        // Cegah kode ruang duplikat (kecuali saat mengedit baris itu sendiri)
        const duplikat = dataRuanganGlobal.find(r => r.code === code && String(r.rowIndex) !== String(rowIndex));
        if (duplikat) {
            showError('ruang-error', `Kode ruang "${code}" sudah dipakai. Gunakan kode lain.`);
            return;
        }

        const defaultText = rowIndex ? "Update Data Ruangan" : "Simpan Data Ruangan";
        setButtonLoading('btn-ruang-submit', true, 'Menyimpan...', defaultText);

        const url = `${SCRIPT_URL}?action=saveRoom&rowIndex=${encodeURIComponent(rowIndex)}&lantai=${encodeURIComponent(lantai)}&code=${encodeURIComponent(code)}&kursi=${encodeURIComponent(kursi)}&tvSmart=${encodeURIComponent(tvSmart)}&ac=${encodeURIComponent(ac)}&stopKontak=${encodeURIComponent(stopKontak)}&papanTulis=${encodeURIComponent(papanTulis)}&waktuLayanan=${encodeURIComponent(waktuLayanan)}&program=${encodeURIComponent(program)}`;
        executeJSONP(url, cb_saveRoom, function (msg) {
            setButtonLoading('btn-ruang-submit', false, 'Menyimpan...', defaultText);
            showError('ruang-error', msg);
        });
    }

    function cb_saveRoom(response) {
        const rowIndex = document.getElementById("ruang-row-index").value;
        const defaultText = rowIndex ? "Update Data Ruangan" : "Simpan Data Ruangan";
        setButtonLoading('btn-ruang-submit', false, 'Menyimpan...', defaultText);
        alert(response.message);
        if (response.status === "success") {
            batalEditRuang();
            loadDataRuangan();
        } else {
            showError('ruang-error', response.message || 'Gagal menyimpan data ruangan.');
        }
    }

    function hapusRuang(rowIndex) {
        const r = dataRuanganGlobal.find(x => x.rowIndex === rowIndex);
        const label = r ? r.code : ('baris ' + rowIndex);
        if (!confirm(`Yakin ingin menghapus ruangan "${label}"? Tindakan ini tidak bisa dibatalkan.`)) return;

        const url = `${SCRIPT_URL}?action=deleteRoom&rowIndex=${rowIndex}`;
        executeJSONP(url, cb_deleteRoom, function (msg) {
            alert(msg);
        });
    }

    function cb_deleteRoom(response) {
        alert(response.message);
        if (response.status === "success") {
            if (document.getElementById("ruang-row-index").value == "") {
                // no-op, form already empty
            } else {
                batalEditRuang();
            }
            loadDataRuangan();
        }
    }

    /* ================================================================
       DATA PEMINJAMAN
       ================================================================ */
    function loadDataPinjaman() {
        document.getElementById("loading-pinjaman").classList.remove("hidden");
        clearError('error-pinjaman');
        executeJSONP(`${SCRIPT_URL}?action=getBookings`, cb_getBookings, function (msg) {
            document.getElementById("loading-pinjaman").classList.add("hidden");
            showError('error-pinjaman', msg);
        });
    }

    function cb_getBookings(response) {
        document.getElementById("loading-pinjaman").classList.add("hidden");
        if (response.status === "success") {
            dataPinjamanGlobal = response.data;
            renderTabelPinjaman(response.data);
        } else {
            showError('error-pinjaman', response.message || 'Gagal memuat data peminjaman.');
        }
    }

    function statusBadgeHtml(status) {
        const map = {
            "Disetujui": "status-disetujui",
            "Ditolak": "status-ditolak"
        };
        const cls = map[status] || "status-diproses";
        return `<span class="${cls}">${escapeHtml(status)}</span>`;
    }

    function aksiAdminHtml(b) {
        const waMessage = `Yth. Bapak/Ibu/Saudara *${b.pemohon}*,\n\nMengenai pengajuan peminjaman ruang *${b.roomCode}* untuk tanggal *${b.tanggal} (${b.jam})* dengan status: *${String(b.status).toUpperCase()}*.\n\nDemikian informasi ini disampaikan. Terima kasih!\n- Admin SIM-RUANG FH UNESA`;
        const waLink = buildWaLink(b.hp, waMessage);
        return `
            <td>
                <button onclick="updateStatus(${b.rowIndex}, 'Disetujui')" class="btn-success btn-sm" type="button">ACC</button>
                <button onclick="updateStatus(${b.rowIndex}, 'Ditolak')" class="btn-danger btn-sm" type="button">Tolak</button>
                <button onclick="relokasiRuang(${b.rowIndex})" class="btn-warning btn-sm" type="button">Pindah</button><br>
                <a href="${waLink}" target="_blank" rel="noopener" style="text-decoration:none; display:inline-block; margin-top:4px; padding:3px 8px; background-color:#25D366; color:white; border-radius:4px; font-size:11px; font-weight:bold;">💬 Chat WA</a>
            </td>
        `;
    }

    function renderTabelPinjaman(bookings) {
        const tbody = document.getElementById("tabel-pinjaman");
        const isAdmin = currentUser && currentUser.role === "admin";

        if (!bookings || bookings.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8">Belum ada pengajuan peminjaman.</td></tr>`;
            return;
        }

        tbody.innerHTML = bookings.map(b => `
            <tr>
                <td>${escapeHtml(b.waktuInput)}</td>
                <td><strong>${escapeHtml(b.roomCode)}</strong></td>
                <td>${escapeHtml(b.pemohon)}</td>
                <td>${escapeHtml(b.nim)}</td>
                <td>${escapeHtml(b.keperluan)}</td>
                <td>${escapeHtml(b.tanggal)}<br><small>(${escapeHtml(b.jam)})</small></td>
                <td>${statusBadgeHtml(b.status)}</td>
                ${isAdmin ? aksiAdminHtml(b) : ""}
            </tr>
        `).join("");
    }

    function filterTabelPinjaman() {
        const q = document.getElementById("cari-pinjaman").value.trim().toLowerCase();
        if (!q) {
            renderTabelPinjaman(dataPinjamanGlobal);
            return;
        }
        const filtered = dataPinjamanGlobal.filter(b =>
            String(b.pemohon).toLowerCase().includes(q) ||
            String(b.roomCode).toLowerCase().includes(q) ||
            String(b.nim).toLowerCase().includes(q) ||
            String(b.keperluan).toLowerCase().includes(q) ||
            String(b.status).toLowerCase().includes(q)
        );
        renderTabelPinjaman(filtered);
    }

    /* ================================================================
       VALIDASI FORM PEMINJAMAN
       ================================================================ */
    function validasiJadwal(tanggal, jamMulai, jamSelesai, errorElId) {
        clearError(errorElId);
        const hariIni = new Date().toISOString().split('T')[0];
        if (tanggal < hariIni) {
            showError(errorElId, 'Tanggal peminjaman tidak boleh sebelum hari ini.');
            return false;
        }
        if (jamMulai >= jamSelesai) {
            showError(errorElId, 'Jam selesai harus lebih besar dari jam mulai.');
            return false;
        }
        return true;
    }

    /* ================================================================
       AKSI: PEMINJAMAN REGULER
       ================================================================ */
    function ajukanPinjaman() {
        const roomCode = document.getElementById("pinjam-ruang").value;
        const tanggal = document.getElementById("pinjam-tanggal").value;
        const jamMulai = document.getElementById("pinjam-jam-mulai").value;
        const jamSelesai = document.getElementById("pinjam-jam-selesai").value;
        const keperluan = document.getElementById("pinjam-keperluan").value.trim();

        if (!roomCode) {
            showError('pinjam-error', 'Silakan pilih ruangan terlebih dahulu.');
            return;
        }
        if (!validasiJadwal(tanggal, jamMulai, jamSelesai, 'pinjam-error')) return;

        const noHpUser = (currentUser && currentUser.hp) ? currentUser.hp : "";

        setButtonLoading('btn-pinjam-submit', true, 'Mengirim...', 'Kirim Pengajuan Peminjaman');
        const url = `${SCRIPT_URL}?action=addBooking&roomCode=${encodeURIComponent(roomCode)}&nama=${encodeURIComponent(currentUser.nama)}&nim=${encodeURIComponent(currentUser.nim || '-')}&hp=${encodeURIComponent(noHpUser)}&keperluan=${encodeURIComponent(keperluan)}&tanggal=${encodeURIComponent(tanggal)}&jamMulai=${encodeURIComponent(jamMulai)}&jamSelesai=${encodeURIComponent(jamSelesai)}`;
        executeJSONP(url, cb_addBooking, function (msg) {
            setButtonLoading('btn-pinjam-submit', false, 'Mengirim...', 'Kirim Pengajuan Peminjaman');
            showError('pinjam-error', msg);
        });
    }

    function cb_addBooking(response) {
        setButtonLoading('btn-pinjam-submit', false, 'Mengirim...', 'Kirim Pengajuan Peminjaman');
        alert(response.message);
        if (response.status === "success") {
            document.getElementById("pinjam-keperluan").value = "";
            if (response.waUrl) window.open(response.waUrl, '_blank');
            loadDataPinjaman();
        } else {
            showError('pinjam-error', response.message || 'Pengajuan gagal diproses.');
        }
    }

    /* ================================================================
       AKSI: BOOKING KILAT PIMPINAN (VIP)
       ================================================================ */
    function ajukanBookingVip() {
        const roomCode = document.getElementById("vip-ruang").value;
        const pemohon = document.getElementById("vip-pemohon").value.trim();
        const tanggal = document.getElementById("vip-tanggal").value;
        const jamMulai = document.getElementById("vip-jam-mulai").value;
        const jamSelesai = document.getElementById("vip-jam-selesai").value;
        const keperluan = document.getElementById("vip-keperluan").value.trim();

        if (!roomCode) {
            showError('vip-error', 'Silakan pilih ruangan terlebih dahulu.');
            return;
        }
        if (!validasiJadwal(tanggal, jamMulai, jamSelesai, 'vip-error')) return;

        setButtonLoading('btn-vip-submit', true, 'Memproses...', 'Eksekusi & Kunci Ruangan Sekarang');
        const url = `${SCRIPT_URL}?action=addVipBooking&roomCode=${encodeURIComponent(roomCode)}&pemohon=${encodeURIComponent(pemohon)}&keperluan=${encodeURIComponent(keperluan)}&tanggal=${encodeURIComponent(tanggal)}&jamMulai=${encodeURIComponent(jamMulai)}&jamSelesai=${encodeURIComponent(jamSelesai)}`;
        executeJSONP(url, cb_addVipBooking, function (msg) {
            setButtonLoading('btn-vip-submit', false, 'Memproses...', 'Eksekusi & Kunci Ruangan Sekarang');
            showError('vip-error', msg);
        });
    }

    function cb_addVipBooking(response) {
        setButtonLoading('btn-vip-submit', false, 'Memproses...', 'Eksekusi & Kunci Ruangan Sekarang');
        alert(response.message);
        if (response.status === "success") {
            document.getElementById("vip-pemohon").value = "";
            document.getElementById("vip-keperluan").value = "";
            loadDataPinjaman();
        } else {
            showError('vip-error', response.message || 'Booking VIP gagal diproses.');
        }
    }

    /* ================================================================
       AKSI ADMIN: UBAH STATUS & RELOKASI
       ================================================================ */
    function updateStatus(rowIndex, newStatus) {
        const url = `${SCRIPT_URL}?action=updateBookingStatus&rowIndex=${rowIndex}&newStatus=${encodeURIComponent(newStatus)}`;
        executeJSONP(url, cb_updateStatus, function (msg) {
            alert(msg);
        });
    }

    function cb_updateStatus(response) {
        alert(response.message);
        if (response.status === "success") {
            if (response.waUrl) window.open(response.waUrl, '_blank');
            loadDataPinjaman();
        }
    }

    function relokasiRuang(rowIndex) {
        document.getElementById("relokasi-row-index").value = rowIndex;

        const select = document.getElementById("select-relokasi-ruang");
        select.innerHTML = '<option value="">-- Pilih Ruangan Baru --</option>' +
            dataRuanganGlobal.map(r => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.code)} (Lantai ${escapeHtml(r.lantai)} - Kapasitas: ${escapeHtml(r.kursi)})</option>`).join("");

        document.getElementById("alasan-relokasi").value = "";
        document.getElementById("modal-relokasi").style.display = "flex";
    }

    function tutupModalRelokasi() {
        document.getElementById("modal-relokasi").style.display = "none";
    }

    function eksekusiRelokasi() {
        const rowIndex = document.getElementById("relokasi-row-index").value;
        const newRoomCode = document.getElementById("select-relokasi-ruang").value;
        const alasan = document.getElementById("alasan-relokasi").value.trim();

        if (!newRoomCode) {
            alert("Silakan pilih ruangan baru terlebih dahulu!");
            return;
        }

        tutupModalRelokasi();
        const url = `${SCRIPT_URL}?action=relocateBooking&rowIndex=${rowIndex}&newRoomCode=${encodeURIComponent(newRoomCode)}&alasan=${encodeURIComponent(alasan)}`;
        executeJSONP(url, cb_relocate, function (msg) {
            alert(msg);
        });
    }

    function cb_relocate(response) {
        if (response.status === "success") {
            if (response.waUrl) {
                if (confirm(response.message + "\n\nKlik 'OK' untuk membuka WhatsApp dan mengirim pesan konfirmasi ke Pemohon.")) {
                    window.open(response.waUrl, '_blank');
                }
            } else {
                alert(response.message + "\n(Catatan: Nomor HP pemohon tidak ditemukan/kosong)");
            }
            loadDataPinjaman();
        } else {
            alert(response.message);
        }
    }

    /* ================================================================
       ASISTEN CUSTOMER SERVICE (AI - GROQ)
       ================================================================ */
    let csHistory = [];
    let csOpened = false;
    let csWaiting = false;

    const CS_QUICK_REPLIES = [
        "Bagaimana cara daftar dan login?",
        "Bagaimana cara mengajukan peminjaman ruangan?",
        "Rekomendasikan ruangan untuk 30 orang dengan AC dan proyektor"
    ];

    function toggleChatCS() {
        const panel = document.getElementById("cs-panel");
        if (panel.classList.contains("hidden")) {
            openChatCS();
        } else if (panel.classList.contains("cs-minimized")) {
            panel.classList.remove("cs-minimized");
            document.getElementById("cs-input").focus();
        } else {
            closeChatCS();
        }
    }

    function openChatCS() {
        const panel = document.getElementById("cs-panel");
        panel.classList.remove("hidden");
        panel.classList.remove("cs-minimized");

        if (!csOpened) {
            csOpened = true;
            appendChatMessage('bot', 'Halo! Saya asisten virtual SIM-RUANG FH UNESA. Saya bisa bantu:\n• Jelaskan cara daftar/login/pinjam ruangan\n• Rekomendasi ruangan sesuai kebutuhan Anda\n• Bantu menuliskan ulang pesan/keperluan jadi lebih sopan\n\nAda yang bisa saya bantu?');
            renderQuickReplies();
        }
        document.getElementById("cs-input").focus();
    }

    function minimizeChatCS() {
        const panel = document.getElementById("cs-panel");
        panel.classList.toggle("cs-minimized");
        if (!panel.classList.contains("cs-minimized")) {
            document.getElementById("cs-input").focus();
        }
    }

    function closeChatCS() {
        const panel = document.getElementById("cs-panel");
        panel.classList.add("hidden");
        panel.classList.remove("cs-minimized");
    }

    function renderQuickReplies() {
        const container = document.getElementById("cs-messages");
        const wrap = document.createElement("div");
        wrap.className = "cs-quick-replies";
        wrap.id = "cs-quick-replies";
        CS_QUICK_REPLIES.forEach(q => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "cs-quick-chip";
            chip.textContent = q;
            chip.onclick = function () {
                const qr = document.getElementById("cs-quick-replies");
                if (qr) qr.remove();
                document.getElementById("cs-input").value = q;
                kirimPesanCS();
            };
            wrap.appendChild(chip);
        });
        container.appendChild(wrap);
        container.scrollTop = container.scrollHeight;
    }

    function appendChatMessage(role, text) {
        const container = document.getElementById("cs-messages");
        const bubble = document.createElement("div");
        bubble.className = "cs-msg " + (role === "user" ? "cs-msg-user" : "cs-msg-bot");
        bubble.textContent = text;
        container.appendChild(bubble);
        container.scrollTop = container.scrollHeight;
        return bubble;
    }

    function kirimPesanCS() {
        if (csWaiting) return;
        const input = document.getElementById("cs-input");
        const text = input.value.trim();
        if (!text) return;

        if (text.length > 1500) {
            appendChatMessage('bot', 'Pesan terlalu panjang, mohon persingkat ya (maks. sekitar 1500 karakter).');
            return;
        }

        const qr = document.getElementById("cs-quick-replies");
        if (qr) qr.remove();

        appendChatMessage('user', text);
        input.value = "";
        csWaiting = true;
        document.getElementById("cs-send-btn").disabled = true;

        const container = document.getElementById("cs-messages");
        const typingBubble = document.createElement("div");
        typingBubble.className = "cs-msg cs-msg-bot cs-msg-typing";
        typingBubble.id = "cs-typing-indicator";
        typingBubble.textContent = "Sedang mengetik...";
        container.appendChild(typingBubble);
        container.scrollTop = container.scrollHeight;

        const historyToSend = csHistory.slice(-6);
        const url = `${SCRIPT_URL}?action=askAssistant&message=${encodeURIComponent(text)}&history=${encodeURIComponent(JSON.stringify(historyToSend))}`;

        executeJSONP(url, cb_askAssistant, function (msg) {
            finishCsTyping();
            appendChatMessage('bot', msg);
        });

        csHistory.push({ role: 'user', content: text });
    }

    function finishCsTyping() {
        csWaiting = false;
        document.getElementById("cs-send-btn").disabled = false;
        const typing = document.getElementById("cs-typing-indicator");
        if (typing) typing.remove();
    }

    function cb_askAssistant(response) {
        finishCsTyping();
        if (response.status === "success") {
            appendChatMessage('bot', response.reply);
            csHistory.push({ role: 'assistant', content: response.reply });
        } else {
            appendChatMessage('bot', response.message || 'Maaf, asisten sedang tidak dapat merespons. Silakan hubungi admin.');
        }
    }

    /* ================================================================
       LAPORAN (KHUSUS ADMIN)
       ================================================================ */
    let lastLaporanData = null;

    function generateLaporan() {
        const mulai = document.getElementById("laporan-tanggal-mulai").value;
        const akhir = document.getElementById("laporan-tanggal-akhir").value;
        const ruangFilter = document.getElementById("laporan-ruang").value;

        if (mulai && akhir && mulai > akhir) {
            alert("Tanggal 'Dari' tidak boleh lebih besar dari tanggal 'Sampai'.");
            return;
        }

        // Filter data peminjaman sesuai periode & ruangan yang dipilih
        let filtered = dataPinjamanGlobal.filter(b => {
            if (mulai && b.tanggal < mulai) return false;
            if (akhir && b.tanggal > akhir) return false;
            if (ruangFilter && b.roomCode !== ruangFilter) return false;
            return true;
        });

        // Statistik approval
        const stats = { total: filtered.length, disetujui: 0, ditolak: 0, menunggu: 0 };
        filtered.forEach(b => {
            if (b.status === "Disetujui") stats.disetujui++;
            else if (b.status === "Ditolak") stats.ditolak++;
            else stats.menunggu++;
        });

        // Rekap jumlah peminjaman per ruangan (semua ruangan ikut tercantum,
        // termasuk yang 0 kali dipakai, supaya laporan lengkap)
        const roomsToShow = ruangFilter ? dataRuanganGlobal.filter(r => r.code === ruangFilter) : dataRuanganGlobal;
        const rekapRuang = roomsToShow.map(r => {
            const jumlah = filtered.filter(b => b.roomCode === r.code).length;
            return { code: r.code, lantai: r.lantai, jumlah: jumlah };
        }).sort((a, b) => b.jumlah - a.jumlah);

        let ruangEkstremText = "";
        const dipakai = rekapRuang.filter(r => r.jumlah > 0);
        if (dipakai.length > 0) {
            const tersibuk = dipakai[0];
            const tersepi = dipakai[dipakai.length - 1];
            ruangEkstremText = `Paling sering dipakai: ${tersibuk.code} (${tersibuk.jumlah}x) — Paling jarang dipakai: ${tersepi.code} (${tersepi.jumlah}x)`;
        } else {
            ruangEkstremText = "Belum ada peminjaman pada periode/ruangan ini.";
        }

        lastLaporanData = {
            mulai: mulai || null,
            akhir: akhir || null,
            ruangFilter: ruangFilter || null,
            stats: stats,
            rekapRuang: rekapRuang,
            detail: filtered
        };

        renderLaporanHasil();
    }

    function renderLaporanHasil() {
        const d = lastLaporanData;
        if (!d) return;

        document.getElementById("laporan-hasil").classList.remove("hidden");

        document.getElementById("laporan-stat-grid").innerHTML = `
            <div class="laporan-stat-item"><span class="laporan-stat-value">${d.stats.total}</span><span class="laporan-stat-label">Total Pengajuan</span></div>
            <div class="laporan-stat-item laporan-stat-success"><span class="laporan-stat-value">${d.stats.disetujui}</span><span class="laporan-stat-label">Disetujui</span></div>
            <div class="laporan-stat-item laporan-stat-danger"><span class="laporan-stat-value">${d.stats.ditolak}</span><span class="laporan-stat-label">Ditolak</span></div>
            <div class="laporan-stat-item laporan-stat-pending"><span class="laporan-stat-value">${d.stats.menunggu}</span><span class="laporan-stat-label">Menunggu</span></div>
        `;

        const dipakai = d.rekapRuang.filter(r => r.jumlah > 0);
        const ekstremEl = document.getElementById("laporan-ruang-ekstrem");
        if (dipakai.length > 0) {
            const tersibuk = dipakai[0];
            const tersepi = dipakai[dipakai.length - 1];
            ekstremEl.textContent = `Paling sering dipakai: ${tersibuk.code} (${tersibuk.jumlah}x) — Paling jarang dipakai: ${tersepi.code} (${tersepi.jumlah}x)`;
        } else {
            ekstremEl.textContent = "Belum ada peminjaman pada periode/ruangan ini.";
        }

        document.getElementById("laporan-tabel-rekap-ruang").innerHTML = d.rekapRuang.length === 0
            ? `<tr><td colspan="3">Tidak ada data ruangan.</td></tr>`
            : d.rekapRuang.map(r => `<tr><td><strong>${escapeHtml(r.code)}</strong></td><td>Lantai ${escapeHtml(r.lantai)}</td><td>${r.jumlah}</td></tr>`).join("");

        document.getElementById("laporan-tabel-detail").innerHTML = d.detail.length === 0
            ? `<tr><td colspan="6">Tidak ada pengajuan pada periode/ruangan ini.</td></tr>`
            : d.detail.map(b => `
                <tr>
                    <td>${escapeHtml(b.tanggal)}<br><small>(${escapeHtml(b.jam)})</small></td>
                    <td><strong>${escapeHtml(b.roomCode)}</strong></td>
                    <td>${escapeHtml(b.pemohon)}</td>
                    <td>${escapeHtml(b.nim)}</td>
                    <td>${escapeHtml(b.keperluan)}</td>
                    <td>${statusBadgeHtml(b.status)}</td>
                </tr>
            `).join("");
    }

    function unduhLaporanPDF() {
        const d = lastLaporanData;
        if (!d) {
            alert("Silakan klik 'Tampilkan Laporan' terlebih dahulu.");
            return;
        }
        if (!window.jspdf) {
            alert("Library pembuat PDF gagal dimuat. Periksa koneksi internet Anda lalu coba lagi.");
            return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: "pt", format: "a4" });
        const periodeText = (d.mulai || d.akhir)
            ? `Periode: ${d.mulai || "awal data"} s/d ${d.akhir || "sekarang"}`
            : "Periode: seluruh data yang tercatat";
        const ruangText = d.ruangFilter ? `Ruangan: ${d.ruangFilter}` : "Ruangan: semua ruangan";
        const tanggalCetak = new Date().toLocaleString("id-ID", { dateStyle: "long", timeStyle: "short" });

        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text("Laporan Peminjaman Ruangan", 40, 45);
        doc.setFontSize(11);
        doc.text("SIM-RUANG - Fakultas Hukum Universitas Negeri Surabaya", 40, 62);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.text(periodeText, 40, 80);
        doc.text(ruangText, 40, 93);
        doc.text("Dicetak: " + tanggalCetak, 40, 106);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.text("Ringkasan Statistik", 40, 128);
        doc.autoTable({
            startY: 135,
            head: [["Total Pengajuan", "Disetujui", "Ditolak", "Menunggu"]],
            body: [[d.stats.total, d.stats.disetujui, d.stats.ditolak, d.stats.menunggu]],
            theme: "grid",
            headStyles: { fillColor: [11, 37, 69] },
            margin: { left: 40, right: 40 }
        });

        let nextY = doc.lastAutoTable.finalY + 20;
        doc.setFont("helvetica", "bold");
        doc.text("Rekap Jumlah Peminjaman per Ruangan", 40, nextY);
        doc.autoTable({
            startY: nextY + 7,
            head: [["Kode Ruang", "Lantai", "Jumlah Peminjaman"]],
            body: d.rekapRuang.map(r => [r.code, "Lantai " + r.lantai, String(r.jumlah)]),
            theme: "grid",
            headStyles: { fillColor: [11, 37, 69] },
            margin: { left: 40, right: 40 }
        });

        nextY = doc.lastAutoTable.finalY + 20;
        doc.setFont("helvetica", "bold");
        doc.text("Daftar Lengkap Peminjaman", 40, nextY);
        doc.autoTable({
            startY: nextY + 7,
            head: [["Tanggal", "Jam", "Ruang", "Pemohon", "NIM/NIP", "Keperluan", "Status"]],
            body: d.detail.map(b => [b.tanggal, b.jam, b.roomCode, b.pemohon, b.nim, b.keperluan, b.status]),
            theme: "grid",
            headStyles: { fillColor: [11, 37, 69] },
            styles: { fontSize: 8 },
            margin: { left: 40, right: 40 }
        });

        const namaFile = "Laporan-SIM-RUANG-" + (d.mulai || "semua") + "_sd_" + (d.akhir || "sekarang") + ".pdf";
        doc.save(namaFile);
    }
