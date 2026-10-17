import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// temp account, hardcoded on purpose
const PROJECT_ID = "7096c3cc-18c6-4229-857a-5adceb37b496";
const PROJECT_SECRET = "xBInVqN_5jW5GJwR9IES9Sc7i5jGiqsFPHvDigNamlo";

let appPromise;
function getApp() {
    appPromise ??= Spectrum({
        projectId: PROJECT_ID,
        projectSecret: PROJECT_SECRET,
        providers: [imessage.config()],
    });
    return appPromise;
}

/**
 * Send an iMessage to a phone number (E.164, e.g. "+15551234567") or email.
 */
export async function sendText(to, body) {
    const app = await getApp();
    const im = imessage(app);
    const user = await im.user(to);
    console.log("to:", JSON.stringify(to), "user:", user);
    const dm = await im.space.create(user);
    return dm.send(body);
}

await sendText("+14086570906", "yo");
console.log("sent");
await (await getApp()).stop();

