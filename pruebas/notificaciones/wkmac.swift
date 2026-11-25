// La app de Mac por dentro: dos WKWebView (el motor real) que comparten almacenamiento.
// A tiene el puente nativo "charla" como la app publicada; B le escribe. Se registra lo
// que A le manda al lado nativo (número del ícono y avisos) y cualquier error de página.
import Cocoa
import WebKit
let url = URL(string: CommandLine.arguments[1])!
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
final class Puente: NSObject, WKScriptMessageHandler {
  var mensajes: [[String: Any]] = []
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { if let d = m.body as? [String: Any] { mensajes.append(d) } }
}
let puente = Puente()
let almacen = WKWebsiteDataStore.nonPersistent()
let pool = WKProcessPool()
func vista(mac: Bool, x: CGFloat) -> WKWebView {
  let cfg = WKWebViewConfiguration(); cfg.websiteDataStore = almacen; cfg.processPool = pool
  let inicio = "window.__errores = []; addEventListener('error', (e) => window.__errores.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errores.push('promesa: ' + String(e.reason && e.reason.message || e.reason)));" + (mac ? "window.charlaEscritorio = true;" : "")
  cfg.userContentController.addUserScript(WKUserScript(source: inicio, injectionTime: .atDocumentStart, forMainFrameOnly: true))
  if mac { cfg.userContentController.add(puente, name: "charla") }
  let win = NSWindow(contentRect: NSRect(x: x, y: -4000, width: 1280, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
  let w = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: cfg)
  win.contentView = w; win.orderFrontRegardless(); ventanas.append(win)
  return w
}
var ventanas: [NSWindow] = []
let A = vista(mac: true, x: -4000), B = vista(mac: false, x: -2600)
func js(_ w: WKWebView, _ codigo: String, _ sigue: @escaping (String) -> Void) {
  w.callAsyncJavaScript(codigo, arguments: [:], in: nil, in: .page) { r in
    switch r { case .success(let v): sigue(v as? String ?? "\(v)"); case .failure(let e): sigue("ERROR \(e.localizedDescription)") }
  }
}
func tras(_ s: Double, _ f: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: f) }
let ayuda = """
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const abrir = async (n, l) => { [...document.querySelectorAll(l + ' .item')].find((x) => x.textContent.includes(n)).click(); await espera(600); };
const enviar = async (t) => { const x = document.querySelector('#composerPrincipal textarea'); x.focus(); x.value = t; x.dispatchEvent(new Event('input', { bubbles: true })); await espera(60); x.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await espera(350); };
"""
func resumen(_ titulo: String) {
  let ins = puente.mensajes.filter { ($0["tipo"] as? String) == "insignia" }.compactMap { $0["n"] as? Int }
  let av = puente.mensajes.filter { ($0["tipo"] as? String) == "aviso" }.map { "\($0["titulo"] ?? "") | \($0["cuerpo"] ?? "")" }
  print("\(titulo): ícono=\(ins.last.map(String.init) ?? "-") avisos=\(av)")
}
tras(4) {
  js(A, "document.querySelectorAll('[data-demo]')[0].click(); return 'ok'") { _ in }
  js(B, "document.querySelectorAll('[data-demo]')[1].click(); return 'ok'") { _ in }
  tras(4) {
    js(A, "document.querySelector('#btnYo').click(); const u = document.querySelector('.menu-cab span').textContent.split('@')[1].trim(); const n = document.querySelector('.menu-cab b').textContent; const ops = [...document.querySelectorAll('.menu-flotante [data-m]')].map((x) => x.textContent.trim()).join(' / '); document.querySelector('.menu-flotante').remove(); return JSON.stringify({ u, n, ops, sw: 'serviceWorker' in navigator, push: 'PushManager' in window, notif: 'Notification' in window, franja: !!document.querySelector('.franja-avisos') })") { yo in
      print("A:", yo); resumen("al abrir")
      let d = try! JSONSerialization.jsonObject(with: yo.data(using: .utf8)!) as! [String: Any]
      let nombre = d["n"] as! String, usuario = d["u"] as! String
      js(B, ayuda + "await abrir('\(nombre)', '#listaDMs'); await enviar('hola desde WebKit'); await enviar('segundo'); await abrir('random', '#listaCanales'); await enviar('sin mención'); await enviar('oye @\(usuario) mira'); return JSON.stringify(window.__errores)") { eb in
        tras(1.5) {
          resumen("B escribió 2 directos + 1 mención")
          js(A, ayuda + "const t1 = document.title; await abrir('Franco', '#listaDMs'); const t2 = document.title; await abrir('random', '#listaCanales'); return JSON.stringify({ t1, t2, t3: document.title, errores: window.__errores })") { ea in
            tras(0.8) {
              resumen("A abrió los dos chats")
              print("títulos y errores de A:", ea); print("errores de B:", eb)
              exit(0)
            }
          }
        }
      }
    }
  }
}
tras(80) { print("tiempo agotado"); exit(1) }
A.load(URLRequest(url: url)); B.load(URLRequest(url: url))
app.run()
