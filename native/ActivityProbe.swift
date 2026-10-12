import AppKit
import CoreGraphics
import ApplicationServices
import Foundation

func emit(_ kind: String = "activity") {
    let app = NSWorkspace.shared.frontmostApplication
    let trusted = AXIsProcessTrusted()
    var record: [String: Any] = ["kind": kind, "observedAt": Date().timeIntervalSince1970,
      "uptime": ProcessInfo.processInfo.systemUptime,
      "foregroundBundleId": app?.bundleIdentifier ?? "unknown",
      "foregroundName": app?.localizedName ?? "Unknown app",
      "idleSeconds": CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!),
      "accessibilityTrusted": trusted]
    // Only window context for Orca, never field contents or a full accessibility tree.
    if trusted, let app = app, (app.bundleIdentifier ?? "").lowercased().contains("orca") {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &value) == .success,
           let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() {
            let window = unsafeBitCast(value, to: AXUIElement.self)
            var title: CFTypeRef?
            if AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success,
               let title = title as? String { record["orcaWindowTitle"] = String(title.prefix(180)) }
        }
    }
    if let data = try? JSONSerialization.data(withJSONObject: record), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
}
emit()
if !CommandLine.arguments.contains("--once") {
    let center = NSWorkspace.shared.notificationCenter
    let tokens = [
      center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in emit() },
      center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in emit("sleep") },
      center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in emit("wake") }
    ]
    let timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in emit() }
    RunLoop.main.run()
    timer.invalidate(); tokens.forEach { center.removeObserver($0) }
}
