import Foundation

@main
struct WidgetSnapshotTests {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_792_412_400)
        let today = WidgetSnapshot.dayString(now)
        let valid = WidgetSnapshot(version: 1, date: today, updatedAt: now.timeIntervalSince1970 - 60,
                                   available: true, running: true, humanSeconds: 0, agentSeconds: 0, workingAgents: 0)
        assert(valid.isFresh(at: now), "Zero activity is a valid current summary")
        let old = WidgetSnapshot(version: 1, date: today, updatedAt: now.timeIntervalSince1970 - 901,
                                 available: true, running: true, humanSeconds: 60, agentSeconds: 60, workingAgents: 1)
        assert(!old.isFresh(at: now), "Expired working-agent data must be hidden")
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: now)!
        let priorDay = WidgetSnapshot(version: 1, date: WidgetSnapshot.dayString(yesterday), updatedAt: now.timeIntervalSince1970 - 60,
                                      available: true, running: true, humanSeconds: 60, agentSeconds: 60, workingAgents: 1)
        assert(!priorDay.isFresh(at: now), "Yesterday's totals must not appear as today's")
        let future = WidgetSnapshot(version: 1, date: today, updatedAt: now.timeIntervalSince1970 + 61,
                                    available: true, running: true, humanSeconds: 0, agentSeconds: 0, workingAgents: 0)
        assert(!future.isFresh(at: now), "Future timestamps must be rejected")
        print("Widget snapshot freshness tests passed")
    }
}
