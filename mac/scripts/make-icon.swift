// Dibuja el ícono de Charla en 1024×1024: squircle violeta y un globo de
// diálogo blanco con tres puntos. Uso: swift make-icon.swift salida.png
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments[1]
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

let inset: CGFloat = 100
let body = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let radius = body.width * 0.225
let shape = CGPath(roundedRect: body, cornerWidth: radius, cornerHeight: radius, transform: nil)

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 34, color: NSColor.black.withAlphaComponent(0.28).cgColor)
ctx.addPath(shape)
ctx.setFillColor(NSColor(srgbRed: 0.43, green: 0.34, blue: 0.81, alpha: 1).cgColor)
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                      colors: [NSColor(srgbRed: 0.56, green: 0.46, blue: 0.95, alpha: 1).cgColor,
                               NSColor(srgbRed: 0.36, green: 0.26, blue: 0.74, alpha: 1).cgColor] as CFArray,
                      locations: [0, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: size - inset), end: CGPoint(x: 0, y: inset), options: [])
ctx.restoreGState()

// Globo: rectángulo redondeado con una colita abajo a la izquierda.
let globo = CGRect(x: 270, y: 380, width: 484, height: 340)
let g = CGMutablePath()
g.addRoundedRect(in: globo, cornerWidth: 110, cornerHeight: 110)
g.move(to: CGPoint(x: 340, y: 400))
g.addLine(to: CGPoint(x: 300, y: 290))
g.addLine(to: CGPoint(x: 450, y: 390))
g.closeSubpath()
ctx.addPath(g)
ctx.setFillColor(NSColor.white.cgColor)
ctx.fillPath()

ctx.setFillColor(NSColor(srgbRed: 0.43, green: 0.34, blue: 0.81, alpha: 1).cgColor)
for x in [412.0, 512.0, 612.0] {
    ctx.fillEllipse(in: CGRect(x: x - 34, y: 550 - 34, width: 68, height: 68))
}

img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
