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

private func selectedOrcaWorktree(_ app: NSRunningApplication) -> String? {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard let rawWindow = attribute(root, kAXFocusedWindowAttribute),
          CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { return nil }
    let window = unsafeBitCast(rawWindow, to: AXUIElement.self)
    var matches: [String] = []
    var visited = 0
    func selectedRow(_ element: AXUIElement) -> Bool {
        if attribute(element, kAXValueAttribute) as? String == "selected" { return true }
        // Orca currently renders the active card without the hover-only class,
        // even when the menu item's AX value still says "not selected".
        for wrapper in children(element) {
            for card in children(wrapper) {
                let style = classes(card)
                if style.contains("rounded-lg"), style.contains("cursor-pointer") {
                    return !style.contains("worktree-sidebar-card-hover")
                }
            }
        }
        return false
    }
    func scan(_ element: AXUIElement, depth: Int) {
        guard depth < 26, visited < 2500 else { return }
        visited += 1
        if attribute(element, kAXRoleAttribute) as? String == "AXMenuItem",
           selectedRow(element),
           let identifier = attribute(element, "AXDOMIdentifier") as? String,
           identifier.hasPrefix("worktree-list-option-"),
           let decoded = identifier.removingPercentEncoding,
           let separator = decoded.lastIndex(of: "|"),
           decoded[decoded.index(after: separator)...].contains("::") {
            matches.append(String(decoded[decoded.index(after: separator)...]))
            return
        }
        for child in children(element) { scan(child, depth: depth + 1) }
    }
    scan(window, depth: 0)
    return matches.count == 1 ? matches[0] : nil
}

private let browserFlags = [
    "com.apple.Safari": "--browser-safari",
    "com.google.Chrome": "--browser-chrome",
    "com.brave.Browser": "--browser-brave"
]

private func browserPage(_ app: NSRunningApplication) -> [String: String]? {
    guard let bundle = app.bundleIdentifier, browserFlags[bundle] != nil else { return nil }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard let rawWindow = attribute(root, kAXFocusedWindowAttribute),
          CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { return nil }
    let window = unsafeBitCast(rawWindow, to: AXUIElement.self)
    func page(_ raw: CFTypeRef?, title: CFTypeRef?) -> [String: String]? {
        let value = raw as? String ?? (raw as? URL)?.absoluteString
        guard let value, value.count <= 2048, var url = URLComponents(string: value),
              url.scheme == "http" || url.scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        url.user = nil; url.password = nil
        var result = ["domain": host.hasPrefix("www.") ? String(host.dropFirst(4)) : host,
                      "url": url.string ?? value]
        if let title = title as? String, !title.isEmpty {
            let suffix = bundle == "com.brave.Browser" ? " - Brave" : bundle == "com.google.Chrome" ? " - Google Chrome" : ""
            let clean = suffix.isEmpty ? title : title.range(of: suffix, options: .backwards).map { String(title[..<$0.lowerBound]) } ?? title
            result["title"] = String(clean.prefix(180))
        }
        return result
    }
    // AXDocument identifies the visible document when the browser provides it.
    if let result = page(attribute(window, kAXDocumentAttribute), title: attribute(window, kAXTitleAttribute)) { return result }
    // Browser tab contents can expose a document URL on their AXWebArea.
    // Only accept a unique domain, because a browser window can contain
    // multiple accessibility trees and selecting the wrong tab is worse than
    // leaving the site unknown.
    var pages: [[String: String]] = [], visited = 0
    func scan(_ element: AXUIElement, depth: Int) {
        guard depth < 12, visited < 400, pages.count < 2 else { return }
        visited += 1
        if attribute(element, kAXRoleAttribute) as? String == "AXWebArea" {
            if let result = page(attribute(element, kAXDocumentAttribute) ?? attribute(element, kAXURLAttribute), title: attribute(element, kAXTitleAttribute)) {
                pages.append(result)
            }
            return
        }
        for child in children(element) { scan(child, depth: depth + 1) }
    }
    scan(window, depth: 0)
    return pages.count == 1 ? pages.first : nil
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
        if let worktree = selectedOrcaWorktree(app) { record["orcaSelectedWorktreeId"] = worktree }
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
    if trusted, let app, let bundle = app.bundleIdentifier,
       let flag = browserFlags[bundle],
       (CommandLine.arguments.contains(flag) || CommandLine.arguments.contains("--browser-tracking")),
       let page = browserPage(app) {
        record["browserDomain"] = page["domain"]
        record["browserUrl"] = page["url"]
        record["browserTitle"] = page["title"]
    }
    if let data = try? JSONSerialization.data(withJSONObject: record), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
}
if CommandLine.arguments.contains("--trust-only") {
    print("{\"accessibilityTrusted\":\(AXIsProcessTrusted() ? "true" : "false")}")
    exit(0)
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
