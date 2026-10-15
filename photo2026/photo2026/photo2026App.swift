import SwiftUI

@main
struct photo2026App: App {
    @UIApplicationDelegateAdaptor(WISSAppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup { WISSView() }
    }
}
