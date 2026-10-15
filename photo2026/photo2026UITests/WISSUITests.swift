import XCTest

// Start a test-only backend on localhost:3099 before this test. No Drive or mail
// credentials are needed; it creates an isolated session without taking photos.
final class WISSUITests: XCTestCase {
    @MainActor
    func testJoinConsentAndLandscapePreview() async throws {
        continueAfterFailure = false
        let base = "http://localhost:3099"
        var create = URLRequest(url: URL(string: base + "/api/wiss/sessions")!)
        create.httpMethod = "POST"
        let (created, _) = try await URLSession.shared.data(for: create)
        let c = try XCTUnwrap(JSONSerialization.jsonObject(with: created) as? [String: Any])
        let sid = try XCTUnwrap(c["sessionId"] as? String)
        let token = try XCTUnwrap(c["token"] as? String)
        var get = URLRequest(url: URL(string: base + "/api/wiss/sessions/" + sid)!)
        get.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let (state, _) = try await URLSession.shared.data(for: get)
        let s = try XCTUnwrap(JSONSerialization.jsonObject(with: state) as? [String: Any])
        let code = try XCTUnwrap(s["joinCode"] as? String)
        let app = XCUIApplication()
        app.launchArguments = ["-WEB_APP_BASE_URL", base, "-API_BASE_URL", base]
        app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        if app.buttons["保存した参加情報をリセット"].waitForExistence(timeout: 2) { app.buttons["保存した参加情報をリセット"].tap() }
        if app.buttons["参加情報をリセット"].exists { app.buttons["参加情報をリセット"].tap() }
        let field = app.textFields["wissJoinCode"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText(code)
        app.buttons["撮影に参加"].tap()
        let consent = app.buttons["この内容で回答する"]
        XCTAssertTrue(consent.waitForExistence(timeout: 15))
        if !consent.isHittable { app.swipeUp() }
        consent.tap()
        XCTAssertTrue(app.staticTexts["お手本写真"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["撮影者の映像 ＋ フレーム"].isHittable)
        XCTAssertTrue(app.buttons["フレームを選ぶ・提案"].isHittable)
        XCTAssertGreaterThan(app.frame.width, app.frame.height)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "WISS landscape two-panel subject screen"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["フレームを選ぶ・提案"].tap()
        XCTAssertTrue(app.staticTexts["公開済みフレームはまだありません。自由撮影をご利用ください。"].waitForExistence(timeout: 10))
        app.buttons["閉じる"].tap()
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["お手本写真"].waitForExistence(timeout: 15))
        var end = URLRequest(url: URL(string: base + "/api/wiss/sessions/" + sid + "/close")!)
        end.httpMethod = "POST"; end.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        _ = try await URLSession.shared.data(for: end)
        let reset = app.buttons["参加情報をリセット"]
        XCTAssertTrue(reset.waitForExistence(timeout: 10)); reset.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
    }
}
