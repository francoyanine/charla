// Charla para Mac: una ventana con la app web de Charla, como Slack.
//
// La app web hace todo; esto le suma lo que un navegador no da:
//   • queda abierta en el Dock aunque se cierre la ventana (⌘Q para salir),
//   • avisos nativos de macOS y el número de no leídos en el ícono,
//   • inicio de sesión con Google en la ventana segura del sistema
//     (Google no deja iniciar sesión dentro de una vista web embebida),
//   • abrir Charla al iniciar sesión en el Mac.
//
// La web y la app se hablan por `window.webkit.messageHandlers.charla`
// (web → app) y por funciones `window.charla*` (app → web).
import AppKit
import AuthenticationServices
import ServiceManagement
import UserNotifications
import WebKit

let URL_CHARLA = URL(string: "https://francoyanine.github.io/charla/")!
let ESQUEMA_LOGIN = "charla"

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler, UNUserNotificationCenterDelegate, ASWebAuthenticationPresentationContextProviding, NSMenuItemValidation {
    var ventana: NSWindow!
    var web: WKWebView!
    var sesionLogin: ASWebAuthenticationSession?

    func applicationDidFinishLaunching(_ notification: Notification) {
        armarMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // la sesión queda guardada entre aperturas
        config.applicationNameForUserAgent = "CharlaMac/1.0"
        let contenido = WKUserContentController()
        contenido.add(self, name: "charla")
        contenido.addUserScript(WKUserScript(source: "window.charlaEscritorio = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = contenido

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.setValue(false, forKey: "drawsBackground")

        ventana = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        ventana.title = "Charla"
        ventana.minSize = NSSize(width: 420, height: 480)
        ventana.contentView = web
        ventana.delegate = self
        ventana.isReleasedWhenClosed = false
        ventana.center()
        ventana.setFrameAutosaveName("CharlaVentana")
        ventana.makeKeyAndOrderFront(nil)

        web.load(URLRequest(url: URL_CHARLA))

        let avisos = UNUserNotificationCenter.current()
        avisos.delegate = self
        avisos.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }

        // La primera vez queda configurada para abrirse al iniciar sesión, como Slack.
        if !UserDefaults.standard.bool(forKey: "inicioConfigurado") {
            UserDefaults.standard.set(true, forKey: "inicioConfigurado")
            try? SMAppService.mainApp.register()
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    // Cerrar la ventana la esconde: Charla sigue conectada y avisando.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        ventana.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mostrar()
        return true
    }

    func mostrar() {
        ventana.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: Menú

    func armarMenu() {
        let principal = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: "Acerca de Charla", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let inicio = NSMenuItem(title: "Abrir al iniciar sesión", action: #selector(alternarInicio(_:)), keyEquivalent: "")
        inicio.target = self
        app.addItem(inicio)
        app.addItem(.separator())
        app.addItem(withTitle: "Ocultar Charla", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Salir de Charla", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        principal.addItem(submenu(app, titulo: "Charla"))

        // Sin este menú, ⌘C / ⌘V / ⌘A no funcionan dentro de la vista web.
        let edicion = NSMenu(title: "Edición")
        edicion.addItem(withTitle: "Deshacer", action: Selector(("undo:")), keyEquivalent: "z")
        edicion.addItem(withTitle: "Rehacer", action: Selector(("redo:")), keyEquivalent: "Z")
        edicion.addItem(.separator())
        edicion.addItem(withTitle: "Cortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edicion.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edicion.addItem(withTitle: "Pegar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edicion.addItem(withTitle: "Seleccionar todo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        principal.addItem(submenu(edicion, titulo: "Edición"))

        let vista = NSMenu(title: "Visualización")
        let recargar = NSMenuItem(title: "Recargar", action: #selector(recargar), keyEquivalent: "r")
        recargar.target = self
        vista.addItem(recargar)
        principal.addItem(submenu(vista, titulo: "Visualización"))

        let ventanaMenu = NSMenu(title: "Ventana")
        ventanaMenu.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        ventanaMenu.addItem(withTitle: "Cerrar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        principal.addItem(submenu(ventanaMenu, titulo: "Ventana"))
        NSApp.windowsMenu = ventanaMenu

        NSApp.mainMenu = principal
    }

    func submenu(_ menu: NSMenu, titulo: String) -> NSMenuItem {
        let item = NSMenuItem(title: titulo, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    @objc func recargar() { web.reload() }

    @objc func alternarInicio(_ sender: NSMenuItem) {
        let servicio = SMAppService.mainApp
        if servicio.status == .enabled { try? servicio.unregister() } else { try? servicio.register() }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(alternarInicio(_:)) {
            item.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
        return true
    }

    // MARK: Mensajes de la web

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let datos = message.body as? [String: Any], let tipo = datos["tipo"] as? String else { return }
        switch tipo {
        case "login":
            if let texto = datos["url"] as? String, let url = URL(string: texto) { iniciarSesion(url) }
        case "aviso":
            avisar(titulo: datos["titulo"] as? String ?? "Charla", cuerpo: datos["cuerpo"] as? String ?? "",
                   canal: datos["canal"] as? String ?? "", id: datos["id"] as? String ?? UUID().uuidString)
        case "insignia":
            let n = (datos["n"] as? NSNumber)?.intValue ?? 0
            NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
        default:
            break
        }
    }

    // MARK: Inicio de sesión con Google

    func iniciarSesion(_ url: URL) {
        let sesion = ASWebAuthenticationSession(url: url, callbackURLScheme: ESQUEMA_LOGIN) { [weak self] vuelta, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let vuelta, let fragmento = vuelta.fragment ?? vuelta.query {
                    let js = "window.charlaSesion && window.charlaSesion(\(self.comoJSON(fragmento)))"
                    self.web.evaluateJavaScript(js)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    self.web.evaluateJavaScript("window.charlaSesion && window.charlaSesion('error_description=cancelado')")
                }
                self.sesionLogin = nil
            }
        }
        sesion.presentationContextProvider = self
        sesion.prefersEphemeralWebBrowserSession = false
        sesionLogin = sesion
        sesion.start()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { ventana }

    func comoJSON(_ texto: String) -> String {
        let datos = try! JSONSerialization.data(withJSONObject: [texto])
        let lista = String(data: datos, encoding: .utf8)!
        return String(lista.dropFirst().dropLast())
    }

    // MARK: Avisos

    func avisar(titulo: String, cuerpo: String, canal: String, id: String) {
        let contenido = UNMutableNotificationContent()
        contenido.title = titulo
        contenido.body = cuerpo
        contenido.sound = .default
        contenido.userInfo = ["canal": canal]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: contenido, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let canal = response.notification.request.content.userInfo["canal"] as? String ?? ""
        DispatchQueue.main.async {
            self.mostrar()
            if !canal.isEmpty { self.web.evaluateJavaScript("window.charlaIrA && window.charlaIrA(\(self.comoJSON(canal)))") }
        }
        completionHandler()
    }

    // MARK: Navegación: lo que no es Charla se abre en el navegador

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        let esCharla = url.host == URL_CHARLA.host && url.path.hasPrefix(URL_CHARLA.path)
        if action.navigationType == .linkActivated && !esCharla {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // Links con target="_blank" (archivos, enlaces externos).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: ventana) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alerta = NSAlert()
        alerta.messageText = message
        alerta.beginSheetModal(for: ventana) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alerta = NSAlert()
        alerta.messageText = message
        alerta.addButton(withTitle: "Aceptar")
        alerta.addButton(withTitle: "Cancelar")
        alerta.beginSheetModal(for: ventana) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    // Si se pierde la conexión al abrir, reintenta en unos segundos.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.web.load(URLRequest(url: URL_CHARLA))
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

let app = NSApplication.shared
let delegado = AppDelegate()
app.delegate = delegado
app.setActivationPolicy(.regular)
app.run()
