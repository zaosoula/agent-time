import Foundation
import Security

let service = "studio.ezyo.agenttime.linear.oauth"
let account = "default"
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

guard CommandLine.arguments.count == 2 else { exit(64) }
let operation = CommandLine.arguments[1]
var status: OSStatus = errSecParam

switch operation {
case "read":
    var result: CFTypeRef?
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data {
        FileHandle.standardOutput.write(data)
    }
case "write":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty, data.count < 16_384 else { exit(64) }
    status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        status = SecItemAdd(item as CFDictionary, nil)
    }
case "delete":
    status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound { status = errSecSuccess }
default:
    exit(64)
}

if status == errSecItemNotFound { exit(2) }
if status != errSecSuccess { exit(1) }
