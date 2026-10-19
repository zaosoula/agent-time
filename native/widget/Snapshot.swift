import Foundation
import Security

let agentTimeWidgetKind = "agent-time-summary"

func agentTimeWidgetGroup() -> String? {
    guard let task = SecTaskCreateFromSelf(nil),
          let groups = SecTaskCopyValueForEntitlement(task, "com.apple.security.application-groups" as CFString, nil) as? [String] else { return nil }
    return groups.first { $0.hasSuffix(".studio.ezyo.agenttime") }
}

struct WidgetSnapshot: Codable, Equatable {
    let version: Int
    let date: String
    let updatedAt: TimeInterval
    let available: Bool
    let running: Bool
    let humanSeconds: Double
    let agentSeconds: Double
    let workingAgents: Int
    let hooksNeedUpdate: Bool?

    static func dayString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar.current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    func isFresh(at now: Date) -> Bool {
        version == 1 && date == Self.dayString(now) &&
        updatedAt <= now.timeIntervalSince1970 + 60 &&
        now.timeIntervalSince1970 - updatedAt < 15 * 60 &&
        humanSeconds.isFinite && humanSeconds >= 0 &&
        agentSeconds.isFinite && agentSeconds >= 0 &&
        workingAgents >= 0
    }

    static func read() -> WidgetSnapshot? {
        guard let group = agentTimeWidgetGroup(),
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let data = try? Data(contentsOf: container.appendingPathComponent("today.json")) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}
