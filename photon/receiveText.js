import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { addUser } from "../main.js";
import { sendText } from "./sendText.js";

export async function startPhoton() {
    try {
        const photon = await Spectrum({
            projectId: "7096c3cc-18c6-4229-857a-5adceb37b496",
            projectSecret: "xBInVqN_5jW5GJwR9IES9Sc7i5jGiqsFPHvDigNamlo",
            providers: [imessage.config()],
        });

        console.log("Listening...");

        for await (const [space, message] of photon.messages) {
            if (message.content.type !== "text") continue;
            const text = message.content.text;
            console.log(text);

            const im = imessage(photon);
            const members = await im.getMembers(space);
            members.forEach((user) => {
                return addUser(user)
            });
        }
    } catch (e) {}
}

// startPhoton().catch(console.error);

