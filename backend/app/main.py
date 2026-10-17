
from decimal import Decimal
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="HackHarvard Group Purchasing")

groups = {}


class CreateGroup(BaseModel):
    space_id: str
    title: str
    target_cents: int = Field(gt=0)
    members: list[str] = Field(min_length=2)


class Contribution(BaseModel):
    member_id: str
    amount_cents: int = Field(gt=0)


@app.post("/groups")
def create_group(data: CreateGroup):
    members = list(dict.fromkeys(data.members))

    if len(members) != len(data.members):
        raise HTTPException(400, "Duplicate members")

    group_id = str(uuid4())

    group = {
        "id": group_id,
        "space_id": data.space_id,
        "title": data.title,
        "target_cents": data.target_cents,
        "members": members,
        "contributions": {},
        "status": "COLLECTING",
    }

    groups[group_id] = group
    return group


@app.get("/groups/{group_id}")
def get_group(group_id: str):
    if group_id not in groups:
        raise HTTPException(404, "Group not found")

    return groups[group_id]


@app.post("/groups/{group_id}/contributions")
def contribute(group_id: str, data: Contribution):
    group = groups.get(group_id)

    if group is None:
        raise HTTPException(404, "Group not found")

    if group["status"] != "COLLECTING":
        raise HTTPException(409, "Group is not collecting")

    if data.member_id not in group["members"]:
        raise HTTPException(403, "Not a group member")

    if data.member_id in group["contributions"]:
        raise HTTPException(409, "Member already contributed")

    collected = sum(group["contributions"].values())

    if collected + data.amount_cents > group["target_cents"]:
        raise HTTPException(400, "Contribution exceeds target")

    group["contributions"][data.member_id] = data.amount_cents

    collected += data.amount_cents

    if collected == group["target_cents"]:
        group["status"] = "FUNDED"

    return {
        "group_id": group_id,
        "collected_cents": collected,
        "target_cents": group["target_cents"],
        "status": group["status"],
    }
