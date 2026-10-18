import {compare,verify} from './tokens.js';

// Only the local operator endpoint exposes token contents. No signing key is
// serialized and attendee payment/watch endpoints never receive private answers.
export function tokenView(booking,secret){
 const initial=booking.initialToken,final=booking.finalToken;if(!initial)return null;
 const initialValid=verify(initial,secret),finalValid=final?verify(final,secret):null;
 const result=final?compare(initial,final,secret):null;
 const labels={bookingId:'Booking',listingId:'Listing',listingUrl:'Listing URL',checkIn:'Check-in',checkOut:'Check-out',guests:'Guests',currency:'Currency',totalCents:'Amount',destination:'Destination',answers:'Guest details'};
 return{initial,final:final||null,initialValid,finalValid,status:result?.status||'WAITING',differences:result?.differences||[],checks:Object.entries(labels).map(([field,label])=>({field,label,match:final?!result.differences.includes(field):null})),paymentStarted:Boolean(booking.bankSpending||booking.bankOperation?.kind==='spend')};
}
