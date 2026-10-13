import AppKit
import CoreGraphics
import ApplicationServices
import Foundation

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

private func classes(_ element: AXUIElement) -> [String] {
    attribute(element, "AXDOMClassList") as? [String] ?? []
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

private func tabLabel(_ element: AXUIElement, depth: Int = 0) -> String? {
    guard depth < 5 else { return nil }
    if attribute(element, kAXRoleAttribute) as? String == "AXStaticText",
       let value = attribute(element, kAXValueAttribute) as? String,
       !value.isEmpty { return String(value.prefix(180)) }
    for child in children(element) {
        if let value = tabLabel(child, depth: depth + 1) { return value }
    }
    return nil
}

private func focusedOrcaTab(_ app: NSRunningApplication) -> String? {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard let rawWindow = attribute(root, kAXFocusedWindowAttribute),
          CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { return nil }
    let window = unsafeBitCast(rawWindow, to: AXUIElement.self)
    var strips: [AXUIElement] = []
    var visited = 0
    func scan(_ element: AXUIElement, depth: Int) {
        guard depth < 26, visited < 2500 else { return }
        visited += 1
        if classes(element).contains("group/tab-strip") { strips.append(element); return }
        for child in children(element) { scan(child, depth: depth + 1) }
    }
    scan(window, depth: 0)
    guard !strips.isEmpty else { return nil }
    var selectedStrip: AXUIElement?
    if strips.count == 1 { selectedStrip = strips[0] }
    else if let rawFocus = attribute(root, kAXFocusedUIElementAttribute),
            CFGetTypeID(rawFocus) == AXUIElementGetTypeID() {
        func frame(_ element: AXUIElement) -> CGRect? {
            guard let raw = attribute(element, "AXFrame"), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
            var rect = CGRect.zero
            return AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cgRect, &rect) ? rect : nil
        }
        var current: AXUIElement? = unsafeBitCast(rawFocus, to: AXUIElement.self)
        var pane: CGRect?
        for _ in 0..<24 {
            guard let node = current else { break }
            if classes(node).contains("pane") { pane = frame(node); break }
            guard let parent = attribute(node, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            current = unsafeBitCast(parent, to: AXUIElement.self)
        }
        if let pane {
            let centerX = pane.midX
            let candidates = strips.compactMap { strip -> (AXUIElement, CGFloat)? in
                guard let rect = frame(strip), rect.minX <= centerX, centerX <= rect.maxX,
                      rect.maxY <= pane.minY + 12 else { return nil }
                return (strip, rect.maxY)
            }.sorted { $0.1 > $1.1 }
            if let first = candidates.first,
               candidates.count == 1 || first.1 - candidates[1].1 > 4 { selectedStrip = first.0 }
        }
    }
    guard let selectedStrip else { return nil }
    var selected: [String] = []
    func scanTabs(_ element: AXUIElement, depth: Int) {
        guard depth < 5 else { return }
        let style = classes(element)
        if style.contains("border-t"), style.contains("cursor-pointer"),
           style.contains(where: { $0.hasPrefix("bg-[color-mix(") }),
           let label = tabLabel(element) { selected.append(label); return }
        for child in children(element) { scanTabs(child, depth: depth + 1) }
    }
    scanTabs(selectedStrip, depth: 0)
    return selected.count == 1 ? selected[0] : nil
}

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
        if let tab = focusedOrcaTab(app) { record["orcaSelectedTabTitle"] = tab }
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
    let timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in emit() }
    RunLoop.main.run()
    timer.invalidate(); tokens.forEach { center.removeObserver($0) }
}
