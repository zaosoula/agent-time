import Foundation
import WidgetKit

struct TraySummary: Decodable {
    let date: String
    let available: Bool
    let running: Bool
    let humanSeconds: Double
    let agentSeconds: Double
    let workingAgents: Int
    let hooksNeedUpdate: Bool
    let captureNeedsAttention: Bool
}

@main
struct SnapshotWriter {
static func main() {
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let summary = try JSONDecoder().decode(TraySummary.self, from: input)
    guard summary.humanSeconds.isFinite && summary.humanSeconds >= 0,
          summary.agentSeconds.isFinite && summary.agentSeconds >= 0,
          summary.workingAgents >= 0 else {
        throw NSError(domain: "AgentTimeWidget", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid summary values"])
    }
    let now = Date()
    guard !summary.available || summary.date == WidgetSnapshot.dayString(now) else {
        throw NSError(domain: "AgentTimeWidget", code: 3, userInfo: [NSLocalizedDescriptionKey: "Summary belongs to another day"])
    }
    let snapshot = WidgetSnapshot(
        version: 1, date: WidgetSnapshot.dayString(now), updatedAt: now.timeIntervalSince1970,
        available: summary.available, running: summary.running && summary.available,
        humanSeconds: summary.available ? summary.humanSeconds : 0,
        agentSeconds: summary.available ? summary.agentSeconds : 0,
        workingAgents: summary.running && summary.available ? summary.workingAgents : 0,
        hooksNeedUpdate: summary.running && summary.available && summary.hooksNeedUpdate,
        captureNeedsAttention: summary.running && summary.available && summary.captureNeedsAttention
    )
    guard let group = agentTimeWidgetGroup(),
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
        throw NSError(domain: "AgentTimeWidget", code: 2, userInfo: [NSLocalizedDescriptionKey: "Widget app group is unavailable"])
    }
    try JSONEncoder().encode(snapshot).write(to: container.appendingPathComponent("today.json"), options: .atomic)
    WidgetCenter.shared.reloadTimelines(ofKind: agentTimeWidgetKind)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
}
}
