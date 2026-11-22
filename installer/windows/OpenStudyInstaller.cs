using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OpenStudyInstaller
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main()
        {
            try
            {
                SetProcessDPIAware();
            }
            catch
            {
                // Ignore on older OS builds
            }

            // Enable TLS 1.2 for HTTPS downloads on .NET Framework 4.x
            try
            {
                ServicePointManager.SecurityProtocol =
                    (SecurityProtocolType)3072 | SecurityProtocolType.Tls;
            }
            catch
            {
                // Ignore if OS enforces defaults
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }

    internal sealed class BorderedCardPanel : Panel
    {
        private Color borderColor;

        public BorderedCardPanel()
        {
            this.borderColor = Color.FromArgb(224, 217, 206);
            this.BackColor = Color.FromArgb(253, 251, 247);
            this.DoubleBuffered = true;
            this.Padding = new Padding(18, 14, 18, 14);
        }

        public Color BorderColor
        {
            get { return this.borderColor; }
            set
            {
                this.borderColor = value;
                this.Invalidate();
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (Pen pen = new Pen(this.borderColor, 1f))
            {
                e.Graphics.DrawRectangle(pen, 0, 0, this.Width - 1, this.Height - 1);
            }
        }
    }

    internal sealed class InstallerForm : Form
    {
        private const string RepoZipUrl =
            "https://github.com/simoneggert16-png/openstudy/archive/refs/heads/main.zip";
        private const string ObsidianDownloadUrl = "https://obsidian.md/download";
        private const string OllamaDownloadUrl = "https://ollama.com/download";
        private const string NodeDownloadUrl = "https://nodejs.org/en/download";
        private const string AppLocalUrl = "http://127.0.0.1:5175";

        private readonly Color bgPage = Color.FromArgb(247, 244, 238);
        private readonly Color bgCard = Color.FromArgb(253, 251, 247);
        private readonly Color bgRaised = Color.FromArgb(239, 233, 223);
        private readonly Color borderColor = Color.FromArgb(224, 217, 206);
        private readonly Color inkPrimary = Color.FromArgb(31, 27, 22);
        private readonly Color inkSecondary = Color.FromArgb(94, 85, 74);
        private readonly Color accentTeal = Color.FromArgb(15, 118, 110);
        private readonly Color accentHover = Color.FromArgb(17, 94, 89);

        private bool isGerman;
        private bool isRunning;
        private string installDir;
        private string vaultDir;

        private Label lblTitle;
        private Label lblSubtitle;
        private Button btnLangToggle;
        private Label lblEnvSummary;
        private Label lblOptionsHeading;
        private CheckBox chkInstallApp;
        private CheckBox chkInstallObsidian;
        private CheckBox chkInstallOllama;
        private CheckBox chkShortcutLaunch;
        private Label lblProgressStatus;
        private ProgressBar progressBar;
        private TextBox txtLog;
        private Button btnInstall;
        private Button btnOpenFolder;
        private Button btnClose;

        private bool hasNode;
        private bool hasGit;
        private bool hasWinget;

        public InstallerForm()
        {
            this.isGerman = true;
            this.isRunning = false;
            this.installDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OpenStudy");
            this.vaultDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "OpenStudy-Vault");

            InitializeLayout();
            RefreshEnvironmentStatus();
            ApplyLocalizedText();
        }

        private void InitializeLayout()
        {
            this.Text = "OpenStudy — Universeller Installer";
            this.ClientSize = new Size(680, 620);
            this.MinimumSize = new Size(640, 580);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = this.bgPage;
            this.ForeColor = this.inkPrimary;
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            // Top accent stripe (subtle 3px teal bar)
            Panel accentStripe = new Panel();
            accentStripe.BackColor = this.accentTeal;
            accentStripe.Location = new Point(0, 0);
            accentStripe.Size = new Size(this.ClientSize.Width, 3);
            accentStripe.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            this.Controls.Add(accentStripe);

            // Header title
            this.lblTitle = new Label();
            this.lblTitle.Font = new Font("Segoe UI Semibold", 16f, FontStyle.Regular);
            this.lblTitle.ForeColor = this.inkPrimary;
            this.lblTitle.Location = new Point(26, 22);
            this.lblTitle.Size = new Size(510, 32);
            this.Controls.Add(this.lblTitle);

            // Header subtitle
            this.lblSubtitle = new Label();
            this.lblSubtitle.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            this.lblSubtitle.ForeColor = this.inkSecondary;
            this.lblSubtitle.Location = new Point(27, 54);
            this.lblSubtitle.Size = new Size(520, 22);
            this.Controls.Add(this.lblSubtitle);

            // Language toggle button
            this.btnLangToggle = new Button();
            this.btnLangToggle.FlatStyle = FlatStyle.Flat;
            this.btnLangToggle.FlatAppearance.BorderColor = this.borderColor;
            this.btnLangToggle.FlatAppearance.BorderSize = 1;
            this.btnLangToggle.BackColor = this.bgCard;
            this.btnLangToggle.ForeColor = this.inkSecondary;
            this.btnLangToggle.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            this.btnLangToggle.Location = new Point(564, 24);
            this.btnLangToggle.Size = new Size(90, 28);
            this.btnLangToggle.Cursor = Cursors.Hand;
            this.btnLangToggle.Click += OnToggleLanguage;
            this.Controls.Add(this.btnLangToggle);

            // Environment status bar
            BorderedCardPanel envCard = new BorderedCardPanel();
            envCard.BackColor = this.bgRaised;
            envCard.BorderColor = this.borderColor;
            envCard.Location = new Point(26, 88);
            envCard.Size = new Size(628, 38);
            this.Controls.Add(envCard);

            this.lblEnvSummary = new Label();
            this.lblEnvSummary.Font = new Font("Segoe UI", 8.8f, FontStyle.Regular);
            this.lblEnvSummary.ForeColor = this.inkSecondary;
            this.lblEnvSummary.Location = new Point(14, 9);
            this.lblEnvSummary.Size = new Size(600, 20);
            envCard.Controls.Add(this.lblEnvSummary);

            // Main options card
            BorderedCardPanel optionsCard = new BorderedCardPanel();
            optionsCard.BackColor = this.bgCard;
            optionsCard.BorderColor = this.borderColor;
            optionsCard.Location = new Point(26, 138);
            optionsCard.Size = new Size(628, 178);
            this.Controls.Add(optionsCard);

            this.lblOptionsHeading = new Label();
            this.lblOptionsHeading.Font = new Font("Segoe UI Semibold", 10f, FontStyle.Regular);
            this.lblOptionsHeading.ForeColor = this.inkPrimary;
            this.lblOptionsHeading.Location = new Point(18, 14);
            this.lblOptionsHeading.Size = new Size(580, 22);
            optionsCard.Controls.Add(this.lblOptionsHeading);

            this.chkInstallApp = CreateOptionCheckbox(44, true);
            optionsCard.Controls.Add(this.chkInstallApp);

            this.chkInstallObsidian = CreateOptionCheckbox(76, true);
            optionsCard.Controls.Add(this.chkInstallObsidian);

            this.chkInstallOllama = CreateOptionCheckbox(108, false);
            optionsCard.Controls.Add(this.chkInstallOllama);

            this.chkShortcutLaunch = CreateOptionCheckbox(140, true);
            optionsCard.Controls.Add(this.chkShortcutLaunch);

            // Progress status label
            this.lblProgressStatus = new Label();
            this.lblProgressStatus.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            this.lblProgressStatus.ForeColor = this.inkSecondary;
            this.lblProgressStatus.Location = new Point(26, 328);
            this.lblProgressStatus.Size = new Size(628, 20);
            this.Controls.Add(this.lblProgressStatus);

            // Progress bar
            this.progressBar = new ProgressBar();
            this.progressBar.Location = new Point(26, 352);
            this.progressBar.Size = new Size(628, 16);
            this.progressBar.Minimum = 0;
            this.progressBar.Maximum = 100;
            this.progressBar.Value = 0;
            this.progressBar.Style = ProgressBarStyle.Continuous;
            this.Controls.Add(this.progressBar);

            // Log output box inside bordered container
            BorderedCardPanel logCard = new BorderedCardPanel();
            logCard.BackColor = this.bgCard;
            logCard.BorderColor = this.borderColor;
            logCard.Location = new Point(26, 378);
            logCard.Size = new Size(628, 172);
            this.Controls.Add(logCard);

            this.txtLog = new TextBox();
            this.txtLog.Multiline = true;
            this.txtLog.ReadOnly = true;
            this.txtLog.ScrollBars = ScrollBars.Vertical;
            this.txtLog.BorderStyle = BorderStyle.None;
            this.txtLog.BackColor = this.bgCard;
            this.txtLog.ForeColor = this.inkPrimary;
            this.txtLog.Font = new Font("Consolas", 8.8f, FontStyle.Regular);
            this.txtLog.Location = new Point(12, 10);
            this.txtLog.Size = new Size(604, 152);
            logCard.Controls.Add(this.txtLog);

            // Footer buttons
            this.btnOpenFolder = new Button();
            this.btnOpenFolder.FlatStyle = FlatStyle.Flat;
            this.btnOpenFolder.FlatAppearance.BorderColor = this.borderColor;
            this.btnOpenFolder.FlatAppearance.BorderSize = 1;
            this.btnOpenFolder.BackColor = this.bgRaised;
            this.btnOpenFolder.ForeColor = this.inkPrimary;
            this.btnOpenFolder.Location = new Point(26, 566);
            this.btnOpenFolder.Size = new Size(148, 36);
            this.btnOpenFolder.Cursor = Cursors.Hand;
            this.btnOpenFolder.Enabled = Directory.Exists(this.installDir);
            this.btnOpenFolder.Click += OnOpenInstallFolder;
            this.Controls.Add(this.btnOpenFolder);

            this.btnClose = new Button();
            this.btnClose.FlatStyle = FlatStyle.Flat;
            this.btnClose.FlatAppearance.BorderColor = this.borderColor;
            this.btnClose.FlatAppearance.BorderSize = 1;
            this.btnClose.BackColor = this.bgCard;
            this.btnClose.ForeColor = this.inkSecondary;
            this.btnClose.Location = new Point(358, 566);
            this.btnClose.Size = new Size(116, 36);
            this.btnClose.Cursor = Cursors.Hand;
            this.btnClose.Click += OnCloseClick;
            this.Controls.Add(this.btnClose);

            this.btnInstall = new Button();
            this.btnInstall.FlatStyle = FlatStyle.Flat;
            this.btnInstall.FlatAppearance.BorderSize = 0;
            this.btnInstall.FlatAppearance.MouseOverBackColor = this.accentHover;
            this.btnInstall.BackColor = this.accentTeal;
            this.btnInstall.ForeColor = Color.White;
            this.btnInstall.Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Regular);
            this.btnInstall.Location = new Point(484, 566);
            this.btnInstall.Size = new Size(170, 36);
            this.btnInstall.Cursor = Cursors.Hand;
            this.btnInstall.Click += OnStartInstallClick;
            this.Controls.Add(this.btnInstall);
        }

        private CheckBox CreateOptionCheckbox(int top, bool isChecked)
        {
            CheckBox cb = new CheckBox();
            cb.Location = new Point(18, top);
            cb.Size = new Size(594, 24);
            cb.Checked = isChecked;
            cb.ForeColor = this.inkPrimary;
            cb.Font = new Font("Segoe UI", 9.3f, FontStyle.Regular);
            cb.UseVisualStyleBackColor = true;
            return cb;
        }

        private string T(string de, string en)
        {
            return this.isGerman ? de : en;
        }

        private void ApplyLocalizedText()
        {
            this.Text = T(
                "OpenStudy — Universeller Installer",
                "OpenStudy — Universal Installer");
            this.lblTitle.Text = T(
                "OpenStudy — Universeller Installer",
                "OpenStudy — Universal Installer");
            this.lblSubtitle.Text = T(
                "Kostenlose Open-Source-Lernplattform · Privat & Lokal",
                "Free open-source learning platform · Private & local");
            this.btnLangToggle.Text = this.isGerman ? "English" : "Deutsch";

            this.lblOptionsHeading.Text = T(
                "Installationsoptionen",
                "Installation options");
            this.chkInstallApp.Text = T(
                "OpenStudy herunterladen & lokal einrichten (%LOCALAPPDATA%\\OpenStudy)",
                "Download & set up OpenStudy locally (%LOCALAPPDATA%\\OpenStudy)");
            this.chkInstallObsidian.Text = T(
                "Obsidian automatisch mitinstallieren & Lern-Vault anlegen (optional)",
                "Automatically install Obsidian & create study vault (optional)");
            this.chkInstallOllama.Text = T(
                "Ollama für 100 % Offline-KI (ohne API-Key) mitinstallieren (optional)",
                "Install Ollama for 100% offline AI without API keys (optional)");
            this.chkShortcutLaunch.Text = T(
                "Desktop-Verknüpfung erstellen & OpenStudy direkt im Browser starten",
                "Create desktop shortcut & launch OpenStudy in browser");

            this.btnOpenFolder.Text = T("Ordner öffnen", "Open folder");
            this.btnClose.Text = T("Schließen", "Close");
            this.btnInstall.Text = this.isRunning
                ? T("Wird eingerichtet...", "Installing...")
                : T("Installation starten", "Start installation");

            if (!this.isRunning && this.progressBar.Value == 0)
            {
                this.lblProgressStatus.Text = T(
                    "Bereit für die lokale Einrichtung. Alle Daten bleiben auf deinem Gerät.",
                    "Ready for local setup. All data stays private on your device.");
            }

            UpdateEnvironmentLabel();
        }

        private void RefreshEnvironmentStatus()
        {
            this.hasNode = !string.IsNullOrEmpty(FindExecutable("node.exe"));
            this.hasGit = !string.IsNullOrEmpty(FindExecutable("git.exe"));
            this.hasWinget = !string.IsNullOrEmpty(FindExecutable("winget.exe"));
            UpdateEnvironmentLabel();
        }

        private void UpdateEnvironmentLabel()
        {
            string nodeState = this.hasNode
                ? T("Erkannt", "Detected")
                : T("Wird automatisch installiert", "Will install automatically");
            string gitState = this.hasGit
                ? T("Erkannt", "Detected")
                : T("Optional (ZIP-Download aktiv)", "Optional (ZIP download ready)");
            string wingetState = this.hasWinget
                ? T("Verfügbar", "Available")
                : T("Manueller Fallback", "Manual fallback");

            this.lblEnvSummary.Text = string.Format(
                "Systemcheck:  Node.js ({0})  ·  Git ({1})  ·  winget ({2})",
                nodeState,
                gitState,
                wingetState);
        }

        private void OnToggleLanguage(object sender, EventArgs e)
        {
            this.isGerman = !this.isGerman;
            ApplyLocalizedText();
        }

        private void OnOpenInstallFolder(object sender, EventArgs e)
        {
            if (Directory.Exists(this.installDir))
            {
                try
                {
                    Process.Start("explorer.exe", this.installDir);
                }
                catch
                {
                    // ignore
                }
            }
        }

        private void OnCloseClick(object sender, EventArgs e)
        {
            if (this.isRunning)
            {
                DialogResult result = MessageBox.Show(
                    T(
                        "Die Installation läuft noch. Möchtest du das Fenster wirklich schließen?",
                        "Installation is still running. Do you really want to close this window?"),
                    "OpenStudy",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (result != DialogResult.Yes)
                {
                    return;
                }
            }
            this.Close();
        }

        private void OnStartInstallClick(object sender, EventArgs e)
        {
            if (this.isRunning) return;

            bool doApp = this.chkInstallApp.Checked;
            bool doObsidian = this.chkInstallObsidian.Checked;
            bool doOllama = this.chkInstallOllama.Checked;
            bool doShortcut = this.chkShortcutLaunch.Checked;

            if (!doApp && !doObsidian && !doOllama && !doShortcut)
            {
                MessageBox.Show(
                    T(
                        "Bitte wähle mindestens eine Option aus.",
                        "Please select at least one option."),
                    "OpenStudy",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            SetRunningState(true);
            this.txtLog.Clear();
            SetProgress(2, T("Einrichtung wird vorbereitet...", "Preparing setup..."));

            Thread worker = new Thread(delegate()
            {
                RunInstallationWorkflow(doApp, doObsidian, doOllama, doShortcut);
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void SetRunningState(bool running)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action<bool>(SetRunningState), running);
                return;
            }

            this.isRunning = running;
            this.chkInstallApp.Enabled = !running;
            this.chkInstallObsidian.Enabled = !running;
            this.chkInstallOllama.Enabled = !running;
            this.chkShortcutLaunch.Enabled = !running;
            this.btnInstall.Enabled = !running;
            this.btnLangToggle.Enabled = !running;
            this.btnOpenFolder.Enabled = !running && Directory.Exists(this.installDir);
            this.btnInstall.Text = running
                ? T("Wird eingerichtet...", "Installing...")
                : T("Installation starten", "Start installation");
        }

        private void SetProgress(int percent, string statusText)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action<int, string>(SetProgress), percent, statusText);
                return;
            }

            int clamped = Math.Max(0, Math.Min(100, percent));
            this.progressBar.Value = clamped;
            this.lblProgressStatus.Text = statusText;
        }

        private void AppendLog(string message)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action<string>(AppendLog), message);
                return;
            }

            string stamp = DateTime.Now.ToString("HH:mm:ss");
            this.txtLog.AppendText(string.Format("[{0}] {1}{2}", stamp, message, Environment.NewLine));
        }

        private void RunInstallationWorkflow(
            bool doApp,
            bool doObsidian,
            bool doOllama,
            bool doShortcut)
        {
            try
            {
                AppendLog(T("Starte OpenStudy Einrichtung.", "Starting OpenStudy setup."));
                AppendLog(string.Format(
                    T("Zielordner: {0}", "Target directory: {0}"),
                    this.installDir));

                if (doApp)
                {
                    SetProgress(10, T("Prüfe Node.js...", "Checking Node.js..."));
                    EnsureNodeInstalled();

                    SetProgress(30, T("Lade OpenStudy herunter...", "Downloading OpenStudy..."));
                    DownloadAndExtractOpenStudy();

                    SetProgress(55, T("Installiere lokale Pakete (npm install)...", "Installing local packages (npm install)..."));
                    RunNpmInstall();

                    SetProgress(72, T("Erstelle Start-OpenStudy.bat...", "Creating Start-OpenStudy.bat..."));
                    CreateStartLauncherScript();
                }

                if (doObsidian)
                {
                    SetProgress(80, T("Richte Obsidian & Lern-Vault ein...", "Setting up Obsidian & study vault..."));
                    InstallOptionalWingetApp(
                        "Obsidian",
                        "Obsidian.Obsidian",
                        ObsidianDownloadUrl,
                        IsObsidianInstalled());
                    CreateStarterObsidianVault();
                }

                if (doOllama)
                {
                    SetProgress(88, T("Installiere Ollama für Offline-KI...", "Installing Ollama for offline AI..."));
                    InstallOptionalWingetApp(
                        "Ollama",
                        "Ollama.Ollama",
                        OllamaDownloadUrl,
                        !string.IsNullOrEmpty(FindExecutable("ollama.exe")));
                }

                if (doShortcut)
                {
                    SetProgress(94, T("Erstelle Desktop-Verknüpfung...", "Creating desktop shortcut..."));
                    if (!File.Exists(Path.Combine(this.installDir, "Start-OpenStudy.bat")))
                    {
                        CreateStartLauncherScript();
                    }
                    CreateDesktopShortcut();
                }

                SetProgress(100, T(
                    "Einrichtung erfolgreich abgeschlossen.",
                    "Setup completed successfully."));
                AppendLog(T(
                    "OpenStudy ist startklar. Alle Lerninhalte bleiben lokal auf diesem Gerät.",
                    "OpenStudy is ready. All study content stays local on this device."));

                if (doShortcut)
                {
                    string batPath = Path.Combine(this.installDir, "Start-OpenStudy.bat");
                    if (File.Exists(batPath))
                    {
                        AppendLog(T(
                            "Starte OpenStudy und öffne den Browser...",
                            "Launching OpenStudy and opening your browser..."));
                        LaunchOpenStudy(batPath);
                    }
                }
            }
            catch (Exception ex)
            {
                AppendLog(string.Format(
                    T("Fehler: {0}", "Error: {0}"),
                    ex.Message));
                SetProgress(this.progressBar.Value, T(
                    "Einrichtung konnte nicht vollständig abgeschlossen werden. Details im Protokoll.",
                    "Setup could not be completed. See log for details."));
            }
            finally
            {
                RefreshEnvironmentFromRegistry();
                this.Invoke(new Action(RefreshEnvironmentStatus));
                SetRunningState(false);
            }
        }

        private void EnsureNodeInstalled()
        {
            RefreshEnvironmentFromRegistry();
            string nodePath = FindExecutable("node.exe");
            if (!string.IsNullOrEmpty(nodePath))
            {
                AppendLog(string.Format(
                    T("Node.js gefunden: {0}", "Node.js found: {0}"),
                    nodePath));
                return;
            }

            AppendLog(T(
                "Node.js wurde nicht gefunden. Versuche automatische Installation über winget...",
                "Node.js was not found. Attempting automatic installation via winget..."));

            string wingetPath = FindExecutable("winget.exe");
            if (!string.IsNullOrEmpty(wingetPath))
            {
                int exitCode = RunProcess(
                    wingetPath,
                    "install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements",
                    null,
                    true);

                RefreshEnvironmentFromRegistry();
                nodePath = FindExecutable("node.exe");
                if (exitCode == 0 && !string.IsNullOrEmpty(nodePath))
                {
                    AppendLog(T(
                        "Node.js LTS erfolgreich installiert.",
                        "Node.js LTS installed successfully."));
                    return;
                }
            }

            AppendLog(T(
                "Öffne offizielle Node.js-Downloadseite als Fallback.",
                "Opening official Node.js download page as fallback."));
            OpenBrowserUrl(NodeDownloadUrl);
            throw new InvalidOperationException(T(
                "Node.js LTS wird benötigt. Bitte installiere Node.js und starte den Installer danach erneut.",
                "Node.js LTS is required. Please install Node.js and run this installer again."));
        }

        private void DownloadAndExtractOpenStudy()
        {
            Directory.CreateDirectory(this.installDir);

            // Preserve local user environment defaults across updates
            string envLocalPath = Path.Combine(this.installDir, ".env.local");
            string preservedEnvLocal = File.Exists(envLocalPath)
                ? File.ReadAllText(envLocalPath, Encoding.UTF8)
                : null;

            string tempRoot = Path.Combine(
                Path.GetTempPath(),
                "openstudy-setup-" + Guid.NewGuid().ToString("N"));
            string zipPath = Path.Combine(tempRoot, "openstudy-main.zip");
            string extractDir = Path.Combine(tempRoot, "extracted");

            Directory.CreateDirectory(tempRoot);
            Directory.CreateDirectory(extractDir);

            try
            {
                bool downloaded = false;
                try
                {
                    AppendLog(string.Format(
                        T("Lade Archiv von {0}...", "Downloading archive from {0}..."),
                        RepoZipUrl));
                    DownloadFile(RepoZipUrl, zipPath);
                    downloaded = File.Exists(zipPath) && new FileInfo(zipPath).Length > 1024;
                }
                catch (Exception downloadEx)
                {
                    AppendLog(string.Format(
                        T("Direkter Download fehlgeschlagen ({0}). Prüfe lokale Quelldateien...",
                          "Direct download failed ({0}). Checking local source files..."),
                        downloadEx.Message));
                }

                string sourceRoot = null;

                if (downloaded)
                {
                    AppendLog(T("Entpacke Archiv...", "Extracting archive..."));
                    try
                    {
                        ZipFile.ExtractToDirectory(zipPath, extractDir);
                    }
                    catch
                    {
                        // Fallback to built-in PowerShell Expand-Archive
                        string psArgs = string.Format(
                            "-NoProfile -ExecutionPolicy Bypass -Command \"Expand-Archive -LiteralPath '{0}' -DestinationPath '{1}' -Force\"",
                            zipPath.Replace("'", "''"),
                            extractDir.Replace("'", "''"));
                        int psExit = RunProcess("powershell.exe", psArgs, null, false);
                        if (psExit != 0)
                        {
                            throw new InvalidOperationException(T(
                                "Archiv konnte nicht entpackt werden.",
                                "Could not extract downloaded archive."));
                        }
                    }

                    string[] subDirs = Directory.GetDirectories(extractDir);
                    if (subDirs.Length == 1 && File.Exists(Path.Combine(subDirs[0], "package.json")))
                    {
                        sourceRoot = subDirs[0];
                    }
                    else if (File.Exists(Path.Combine(extractDir, "package.json")))
                    {
                        sourceRoot = extractDir;
                    }
                }
                else
                {
                    // Offline fallback: check if installer was executed inside an existing local checkout
                    string localCheckout = FindNearbyLocalCheckout();
                    if (!string.IsNullOrEmpty(localCheckout))
                    {
                        AppendLog(T(
                            "Lokale OpenStudy-Dateien erkannt. Kopiere Offline-Installation...",
                            "Local OpenStudy files detected. Copying offline installation..."));
                        sourceRoot = localCheckout;
                    }
                }

                if (string.IsNullOrEmpty(sourceRoot))
                {
                    throw new InvalidOperationException(T(
                        "OpenStudy konnte nicht heruntergeladen werden. Prüfe deine Internetverbindung.",
                        "Could not download OpenStudy. Please check your internet connection."));
                }

                AppendLog(T(
                    "Kopiere OpenStudy in den Zielordner...",
                    "Copying OpenStudy into target directory..."));
                CopyDirectoryFiltered(sourceRoot, this.installDir);

                if (preservedEnvLocal != null)
                {
                    File.WriteAllText(envLocalPath, preservedEnvLocal, Encoding.UTF8);
                }
            }
            finally
            {
                try
                {
                    if (Directory.Exists(tempRoot))
                    {
                        Directory.Delete(tempRoot, true);
                    }
                }
                catch
                {
                    // ignore temp cleanup failure
                }
            }
        }

        private string FindNearbyLocalCheckout()
        {
            try
            {
                string current = AppDomain.CurrentDomain.BaseDirectory;
                for (int depth = 0; depth < 4 && !string.IsNullOrEmpty(current); depth++)
                {
                    string pkgPath = Path.Combine(current, "package.json");
                    if (File.Exists(pkgPath))
                    {
                        string text = File.ReadAllText(pkgPath, Encoding.UTF8);
                        if (text.IndexOf("\"name\": \"openstudy\"", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            return current;
                        }
                    }
                    DirectoryInfo parent = Directory.GetParent(current.TrimEnd(Path.DirectorySeparatorChar));
                    current = parent != null ? parent.FullName : null;
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private void DownloadFile(string url, string destinationPath)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.AllowAutoRedirect = true;
            request.UserAgent = "OpenStudy-Installer/1.0";
            request.Timeout = 30000;
            request.ReadWriteTimeout = 60000;

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream input = response.GetResponseStream())
            using (FileStream output = new FileStream(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                if (input == null)
                {
                    throw new IOException("Empty HTTP response stream.");
                }
                byte[] buffer = new byte[16384];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                }
            }
        }

        private void CopyDirectoryFiltered(string sourceDir, string targetDir)
        {
            HashSet<string> skipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "node_modules",
                ".git",
                "dist",
                "private",
                "secrets"
            };

            Directory.CreateDirectory(targetDir);

            string[] files = Directory.GetFiles(sourceDir);
            for (int i = 0; i < files.Length; i++)
            {
                string file = files[i];
                string name = Path.GetFileName(file);
                if (name.Equals(".env.local", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals(".env", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string destFile = Path.Combine(targetDir, name);
                File.Copy(file, destFile, true);
            }

            string[] dirs = Directory.GetDirectories(sourceDir);
            for (int i = 0; i < dirs.Length; i++)
            {
                string dir = dirs[i];
                string dirName = Path.GetFileName(dir);
                if (skipDirs.Contains(dirName))
                {
                    continue;
                }
                CopyDirectoryFiltered(dir, Path.Combine(targetDir, dirName));
            }
        }

        private void RunNpmInstall()
        {
            RefreshEnvironmentFromRegistry();
            string npmCmd = FindExecutable("npm.cmd");
            if (string.IsNullOrEmpty(npmCmd))
            {
                npmCmd = FindExecutable("npm");
            }
            if (string.IsNullOrEmpty(npmCmd))
            {
                throw new InvalidOperationException(T(
                    "npm wurde nicht gefunden. Bitte starte das System nach der Node.js-Installation kurz neu.",
                    "npm was not found. Please reopen this installer after Node.js setup."));
            }

            AppendLog(T(
                "Führe npm install aus (dies kann beim ersten Mal 1-2 Minuten dauern)...",
                "Running npm install (first setup may take 1-2 minutes)..."));

            int exitCode = RunProcess(
                "cmd.exe",
                string.Format("/c \"\"{0}\" install --no-audit --no-fund\"", npmCmd),
                this.installDir,
                true);

            if (exitCode != 0)
            {
                throw new InvalidOperationException(T(
                    "npm install meldete einen Fehler. Prüfe das Protokoll oben.",
                    "npm install returned an error. Check the log above."));
            }

            AppendLog(T(
                "Abhängigkeiten erfolgreich installiert.",
                "Dependencies installed successfully."));
        }

        private void CreateStartLauncherScript()
        {
            Directory.CreateDirectory(this.installDir);
            string batPath = Path.Combine(this.installDir, "Start-OpenStudy.bat");

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("@echo off");
            sb.AppendLine("setlocal");
            sb.AppendLine("title OpenStudy Local Studio");
            sb.AppendLine("cd /d \"%~dp0\"");
            sb.AppendLine("");
            sb.AppendLine("echo ====================================================");
            sb.AppendLine("echo  OpenStudy - Lokale Lernplattform & Companion Bridge");
            sb.AppendLine("echo  App:    http://127.0.0.1:5175");
            sb.AppendLine("echo  Bridge: http://127.0.0.1:4319");
            sb.AppendLine("echo ====================================================");
            sb.AppendLine("echo.");
            sb.AppendLine("");
            sb.AppendLine("if exist \"bridge\\server.mjs\" (");
            sb.AppendLine("  start \"OpenStudy Companion Bridge\" /min cmd /c \"node bridge\\server.mjs\"");
            sb.AppendLine(")");
            sb.AppendLine("");
            sb.AppendLine("start \"\" /b powershell -NoProfile -WindowStyle Hidden -Command \"Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:5175'\"");
            sb.AppendLine("call npm run dev -- --host 127.0.0.1 --port 5175");
            sb.AppendLine("endlocal");

            File.WriteAllText(batPath, sb.ToString(), new UTF8Encoding(false));
            AppendLog(string.Format(
                T("Starter erstellt: {0}", "Launcher created: {0}"),
                batPath));
        }

        private void InstallOptionalWingetApp(
            string displayName,
            string wingetId,
            string fallbackUrl,
            bool alreadyInstalled)
        {
            if (alreadyInstalled)
            {
                AppendLog(string.Format(
                    T("{0} ist bereits installiert.", "{0} is already installed."),
                    displayName));
                return;
            }

            string wingetPath = FindExecutable("winget.exe");
            if (string.IsNullOrEmpty(wingetPath))
            {
                AppendLog(string.Format(
                    T("winget nicht verfügbar. Öffne offizielle {0}-Downloadseite.",
                      "winget not available. Opening official {0} download page."),
                    displayName));
                OpenBrowserUrl(fallbackUrl);
                return;
            }

            AppendLog(string.Format(
                T("Installiere {0} über winget ({1})...", "Installing {0} via winget ({1})..."),
                displayName,
                wingetId));

            int exitCode = RunProcess(
                wingetPath,
                string.Format(
                    "install --id {0} -e --accept-source-agreements --accept-package-agreements",
                    wingetId),
                null,
                true);

            if (exitCode == 0)
            {
                AppendLog(string.Format(
                    T("{0} erfolgreich installiert.", "{0} installed successfully."),
                    displayName));
            }
            else
            {
                AppendLog(string.Format(
                    T("{0} konnte per winget nicht automatisch installiert werden (Code {1}). Öffne offizielle Downloadseite.",
                      "{0} could not be installed via winget (code {1}). Opening official download page."),
                    displayName,
                    exitCode));
                OpenBrowserUrl(fallbackUrl);
            }
        }

        private bool IsObsidianInstalled()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string[] candidates = new string[]
            {
                Path.Combine(localAppData, "Obsidian", "Obsidian.exe"),
                Path.Combine(localAppData, "Programs", "obsidian", "Obsidian.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Obsidian", "Obsidian.exe")
            };

            for (int i = 0; i < candidates.Length; i++)
            {
                if (File.Exists(candidates[i]))
                {
                    return true;
                }
            }
            return false;
        }

        private void CreateStarterObsidianVault()
        {
            try
            {
                Directory.CreateDirectory(this.vaultDir);
                string welcomeFile = Path.Combine(this.vaultDir, "Willkommen-bei-OpenStudy.md");
                if (!File.Exists(welcomeFile))
                {
                    StringBuilder sb = new StringBuilder();
                    sb.AppendLine("# Willkommen in deinem OpenStudy Lern-Vault");
                    sb.AppendLine("");
                    sb.AppendLine("Dieser Ordner gehört dir allein und bleibt vollständig lokal auf deinem Gerät.");
                    sb.AppendLine("");
                    sb.AppendLine("## Erste Schritte");
                    sb.AppendLine("- Öffne diesen Ordner in **Obsidian** als lokalen Vault.");
                    sb.AppendLine("- Verknüpfe deinen Vault in **OpenStudy** unter *Import & Sync*.");
                    sb.AppendLine("- Erstelle für jedes Fach eigene Notizen und verlinke Konzepte mit `[[Begriff]]`.");
                    sb.AppendLine("");
                    sb.AppendLine("## Beispiel-Verknüpfungen");
                    sb.AppendLine("- [[Lernplan]]");
                    sb.AppendLine("- [[Prüfungsvorbereitung]]");
                    File.WriteAllText(welcomeFile, sb.ToString(), new UTF8Encoding(false));
                }

                AppendLog(string.Format(
                    T("Obsidian Lern-Vault bereit: {0}", "Obsidian study vault ready: {0}"),
                    this.vaultDir));
            }
            catch (Exception ex)
            {
                AppendLog(string.Format(
                    T("Hinweis: Lern-Vault konnte nicht angelegt werden ({0}).",
                      "Note: Could not create study vault ({0})."),
                    ex.Message));
            }
        }

        private void CreateDesktopShortcut()
        {
            string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string shortcutPath = Path.Combine(desktopDir, "OpenStudy.lnk");
            string targetBat = Path.Combine(this.installDir, "Start-OpenStudy.bat");

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments =
                "-NoProfile -ExecutionPolicy Bypass -Command \"" +
                "$ws = New-Object -ComObject WScript.Shell; " +
                "$sc = $ws.CreateShortcut($env:OS_SC_PATH); " +
                "$sc.TargetPath = $env:OS_SC_TARGET; " +
                "$sc.WorkingDirectory = $env:OS_SC_WORKDIR; " +
                "$sc.Description = 'OpenStudy — Lokale Lernplattform'; " +
                "$sc.Save()\"";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.EnvironmentVariables["OS_SC_PATH"] = shortcutPath;
            psi.EnvironmentVariables["OS_SC_TARGET"] = targetBat;
            psi.EnvironmentVariables["OS_SC_WORKDIR"] = this.installDir;

            using (Process proc = Process.Start(psi))
            {
                if (proc != null)
                {
                    proc.WaitForExit(15000);
                    if (proc.ExitCode == 0)
                    {
                        AppendLog(string.Format(
                            T("Desktop-Verknüpfung erstellt: {0}", "Desktop shortcut created: {0}"),
                            shortcutPath));
                        return;
                    }
                }
            }

            AppendLog(T(
                "Hinweis: Desktop-Verknüpfung konnte nicht erstellt werden. Starte OpenStudy über Start-OpenStudy.bat.",
                "Note: Could not create desktop shortcut. Launch OpenStudy via Start-OpenStudy.bat."));
        }

        private void LaunchOpenStudy(string batPath)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = batPath;
                psi.WorkingDirectory = this.installDir;
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                AppendLog(string.Format(
                    T("Automatisches Starten fehlgeschlagen ({0}). Öffne manuell {1}.",
                      "Auto-launch failed ({0}). Open {1} manually."),
                    ex.Message,
                    AppLocalUrl));
            }
        }

        private void OpenBrowserUrl(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch
            {
                // ignore
            }
        }

        private int RunProcess(string fileName, string arguments, string workingDir, bool streamLog)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = fileName;
            psi.Arguments = arguments;
            if (!string.IsNullOrEmpty(workingDir))
            {
                psi.WorkingDirectory = workingDir;
            }
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            using (Process proc = new Process())
            {
                proc.StartInfo = psi;
                proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (streamLog && !string.IsNullOrWhiteSpace(e.Data))
                    {
                        AppendLog("  " + e.Data.Trim());
                    }
                };
                proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (streamLog && !string.IsNullOrWhiteSpace(e.Data))
                    {
                        AppendLog("  " + e.Data.Trim());
                    }
                };

                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                proc.WaitForExit();
                return proc.ExitCode;
            }
        }

        private static string FindExecutable(string exeName)
        {
            string envPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            string[] dirs = envPath.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < dirs.Length; i++)
            {
                string dir = dirs[i].Trim().Trim('"');
                if (string.IsNullOrEmpty(dir)) continue;
                try
                {
                    string candidate = Path.Combine(dir, exeName);
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch
                {
                    // ignore invalid path entries
                }
            }

            // Check standard Node.js install directory as fallback
            if (exeName.Equals("node.exe", StringComparison.OrdinalIgnoreCase) ||
                exeName.Equals("npm.cmd", StringComparison.OrdinalIgnoreCase))
            {
                string programFilesNode = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "nodejs",
                    exeName);
                if (File.Exists(programFilesNode))
                {
                    return programFilesNode;
                }
            }

            return null;
        }

        private static void RefreshEnvironmentFromRegistry()
        {
            try
            {
                string machinePath = string.Empty;
                string userPath = string.Empty;

                using (RegistryKey machineKey = Registry.LocalMachine.OpenSubKey(
                    @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"))
                {
                    if (machineKey != null)
                    {
                        object val = machineKey.GetValue("Path");
                        if (val != null) machinePath = val.ToString();
                    }
                }

                using (RegistryKey userKey = Registry.CurrentUser.OpenSubKey("Environment"))
                {
                    if (userKey != null)
                    {
                        object val = userKey.GetValue("Path");
                        if (val != null) userPath = val.ToString();
                    }
                }

                string combined = string.Join(";", new string[] { machinePath, userPath });
                if (!string.IsNullOrWhiteSpace(combined))
                {
                    Environment.SetEnvironmentVariable("PATH", combined);
                }
            }
            catch
            {
                // ignore registry read failures
            }
        }
    }
}
