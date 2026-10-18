import { sendText } from "./photon/sendText.js";


// ----------------------------

let friends = [];

export function addUser(user) {
    friends.push(user.address);
}


// ----------------------------

let listing = "";

export function setListing(l) {
    sendText("Could you send the URL of the listing");

}



